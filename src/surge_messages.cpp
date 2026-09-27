#include "surge_messages.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "LFOModulationSource.h"
#include "ModulationSource.h"
#include "Oscillator.h"
#include "Parameter.h"
#include "SurgeStorage.h"
#include "SurgeSynthesizer.h"
#include <sst/filters/HalfRateFilter.h>

namespace
{

// ---------------------------------------------------------------------------
// Bounded JSON: a strict reader for requests and a small writer for replies.
// ---------------------------------------------------------------------------

struct Json
{
    enum Type
    {
        Null,
        Number,
        String,
        Boolean,
        Object,
        Array
    } type = Null;
    double number = 0;
    bool boolean = false;
    std::string string;
    std::map<std::string, Json> object;
    std::vector<Json> array;
    const Json *get(const char *key) const
    {
        auto i = object.find(key);
        return i == object.end() ? nullptr : &i->second;
    }
    bool integer(const char *key, long &out) const
    {
        auto *v = get(key);
        if (!v || v->type != Number || v->number != std::floor(v->number))
            return false;
        out = long(v->number);
        return true;
    }
    std::string str(const char *key) const
    {
        auto *v = get(key);
        return v && v->type == String ? v->string : "";
    }
};

struct Reader
{
    const char *p;
    const char *end;
    size_t nodes = 0;
    void space()
    {
        while (p < end && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t'))
            ++p;
    }
    bool take(char c)
    {
        space();
        if (p == end || *p != c)
            return false;
        ++p;
        return true;
    }
    bool str(std::string &out)
    {
        if (!take('"'))
            return false;
        while (p < end)
        {
            unsigned char c = *p++;
            if (c == '"')
                return true;
            if (c < 32)
                return false;
            if (c != '\\')
            {
                out += char(c);
                continue;
            }
            if (p == end)
                return false;
            c = *p++;
            if (c == '"' || c == '\\' || c == '/')
                out += char(c);
            else if (c == 'n')
                out += '\n';
            else if (c == 't')
                out += '\t';
            else if (c == 'r')
                out += '\r';
            else if (c == 'u')
            {
                unsigned code = 0;
                for (int i = 0; i < 4; i++)
                {
                    if (p == end)
                        return false;
                    char h = *p++;
                    unsigned n = h >= '0' && h <= '9'   ? h - '0'
                                 : h >= 'a' && h <= 'f' ? h - 'a' + 10
                                 : h >= 'A' && h <= 'F' ? h - 'A' + 10
                                                        : 16;
                    if (n == 16)
                        return false;
                    code = code * 16 + n;
                }
                if (code < 128)
                    out += char(code);
                else if (code < 2048)
                {
                    out += char(0xc0 | (code >> 6));
                    out += char(0x80 | (code & 63));
                }
                else
                {
                    out += char(0xe0 | (code >> 12));
                    out += char(0x80 | ((code >> 6) & 63));
                    out += char(0x80 | (code & 63));
                }
            }
            else
                return false;
        }
        return false;
    }
    bool read(Json &out, unsigned depth = 0)
    {
        space();
        if (p == end || depth > 8 || ++nodes > 8192)
            return false;
        if (*p == '"')
        {
            out.type = Json::String;
            return str(out.string);
        }
        if (*p == '{')
        {
            ++p;
            out.type = Json::Object;
            if (take('}'))
                return true;
            do
            {
                std::string key;
                if (!str(key) || !take(':') || out.object.count(key))
                    return false;
                Json child;
                if (!read(child, depth + 1))
                    return false;
                out.object.emplace(std::move(key), std::move(child));
                if (take('}'))
                    return true;
            } while (take(','));
            return false;
        }
        if (*p == '[')
        {
            ++p;
            out.type = Json::Array;
            if (take(']'))
                return true;
            do
            {
                Json child;
                if (!read(child, depth + 1))
                    return false;
                out.array.push_back(std::move(child));
                if (take(']'))
                    return true;
            } while (take(','));
            return false;
        }
        for (auto literal : {"true", "false", "null"})
        {
            auto q = p;
            const char *l = literal;
            while (q < end && *l && *q == *l)
            {
                q++;
                l++;
            }
            if (!*l)
            {
                p = q;
                out.type = literal[0] == 'n' ? Json::Null : Json::Boolean;
                out.boolean = literal[0] == 't';
                return true;
            }
        }
        char *stop = nullptr;
        std::string text(p, std::min<size_t>(size_t(end - p), 64));
        out.number = std::strtod(text.c_str(), &stop);
        if (stop == text.c_str() || !std::isfinite(out.number))
            return false;
        p += stop - text.c_str();
        out.type = Json::Number;
        return true;
    }
};

std::string quote(const std::string &s)
{
    std::string out = "\"";
    for (unsigned char c : s)
    {
        if (c == '"' || c == '\\')
        {
            out += '\\';
            out += char(c);
        }
        else if (c < 32)
        {
            char b[8];
            std::snprintf(b, sizeof(b), "\\u%04x", c);
            out += b;
        }
        else
            out += char(c);
    }
    return out + '"';
}

std::string number(double v)
{
    char b[32];
    std::snprintf(b, sizeof(b), "%.6g", std::isfinite(v) ? v : 0.0);
    return b;
}

std::string error(const std::string &message) { return "{\"error\":" + quote(message) + "}"; }

constexpr long kMaxIds = 1024;
constexpr long kMaxPoints = 1024;

Parameter *param(SurgeSynthesizer &synth, long id)
{
    auto &params = synth.storage.getPatch().param_ptr;
    return id >= 0 && size_t(id) < params.size() ? params[size_t(id)] : nullptr;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Names, value text and state the editor needs to label controls like upstream. */
std::string paramInfo(SurgeSynthesizer &synth, const Json &request)
{
    auto *ids = request.get("ids");
    if (!ids || ids->type != Json::Array || long(ids->array.size()) > kMaxIds)
        return error("paramInfo needs ids (at most 1024)");
    std::string out = "{\"params\":[";
    bool first = true;
    for (auto &entry : ids->array)
    {
        if (entry.type != Json::Number)
            continue;
        auto *p = param(synth, long(entry.number));
        if (!p)
            continue;
        out += first ? "{" : ",{";
        first = false;
        out += "\"id\":" + number(p->id);
        out += ",\"name\":" + quote(p->get_name() ? p->get_name() : "");
        out += ",\"display\":" + quote(p->get_display());
        out += ",\"bipolar\":" + std::string(p->is_bipolar() ? "true" : "false");
        out += ",\"deactivated\":" + std::string(p->appears_deactivated() ? "true" : "false");
        out += ",\"none\":" + std::string(p->ctrltype == ct_none ? "true" : "false");
        out += "}";
    }
    return out + "]}";
}

/** Upstream's type-in: parse without touching the patch, reply the normalized value. */
std::string parse(SurgeSynthesizer &synth, const Json &request)
{
    long id = -1;
    auto *p = request.integer("id", id) ? param(synth, id) : nullptr;
    if (!p)
        return error("unknown parameter");
    if (!p->can_setvalue_from_string())
        return error("this parameter does not accept typed values");
    pdata value = p->val;
    std::string message;
    if (!p->set_value_from_string_onto(request.str("text"), value, message))
        return error(message.empty() ? "invalid value" : message);
    double normalized = 0;
    switch (p->valtype)
    {
    case vt_float:
        normalized = p->value_to_normalized(value.f);
        break;
    case vt_int:
        normalized = p->val_max.i > p->val_min.i
                         ? double(value.i - p->val_min.i) / double(p->val_max.i - p->val_min.i)
                         : 0.0;
        break;
    case vt_bool:
        normalized = value.b ? 1.0 : 0.0;
        break;
    }
    return "{\"value\":" + number(std::clamp(normalized, 0.0, 1.0)) + "}";
}

/** Subtype count and names for a filter unit's current type (sst::filters tables). */
std::string filterSubtypes(SurgeSynthesizer &synth, const Json &request)
{
    long scene = 0, unit = 0;
    if (!request.integer("scene", scene) || !request.integer("unit", unit) || scene < 0 ||
        scene >= n_scenes || unit < 0 || unit >= n_filterunits_per_scene)
        return error("filterSubtypes needs scene and unit");
    auto &filter = synth.storage.getPatch().scene[scene].filterunit[unit];
    const int type = filter.type.val.i;
    const int count = type >= 0 && type < sst::filters::num_filter_types ? sst::filters::fut_subcount[type] : 0;
    std::string out = "{\"count\":" + number(count) + ",\"names\":[";
    const int saved = filter.subtype.val.i;
    for (int i = 0; i < count; ++i)
    {
        filter.subtype.val.i = i; // restored below; display only
        out += (i ? "," : "") + quote(filter.subtype.get_display());
    }
    filter.subtype.val.i = saved;
    return out + "]}";
}

/** OscillatorWaveformDisplay::paint's sampling, returning the averaged samples. */
std::string renderOsc(SurgeSynthesizer &synth, const Json &request)
{
    long scene = 0, osc = 0, points = 256;
    request.integer("points", points);
    if (!request.integer("scene", scene) || !request.integer("osc", osc) || scene < 0 ||
        scene >= n_scenes || osc < 0 || osc >= n_oscs || points < 8 || points > kMaxPoints)
        return error("renderOsc needs scene, osc and 8..1024 points");
    auto *storage = &synth.storage;
    auto *oscdata = &storage->getPatch().scene[scene].osc[osc];
    pdata tp[n_scene_params];
    tp[oscdata->pitch.param_id_in_scene].f = 0;
    for (int i = 0; i < n_osc_params; i++)
        tp[oscdata->p[i].param_id_in_scene].i = oscdata->p[i].val.i;
    alignas(16) static unsigned char buffer[oscillator_buffer_size];
    auto *o = spawn_osc(oscdata->type.val.i, storage, oscdata, tp, tp, buffer);
    if (!o)
        return error("no oscillator");
    const float pitch = 90.15f - 48.f + 12.f * std::log2(storage->dsamplerate / 44100.0);
    const bool display = o->allow_display();
    if (display)
        o->init(pitch, true, true);
    constexpr int averaging = 4;
    const int total = int(points) * averaging;
    int position = BLOCK_SIZE;
    alignas(16) float tmp[2][BLOCK_SIZE_OS];
    sst::filters::HalfRate::HalfRateFilter halfRate(6, true);
    halfRate.load_coefficients();
    halfRate.reset();
    std::string out = "{\"samples\":[";
    for (int i = 0; i < total; i += averaging)
    {
        if (display && position >= BLOCK_SIZE)
        {
            o->process_block(pitch);
            std::memcpy(tmp[0], o->output, sizeof(tmp[0]));
            std::memcpy(tmp[1], o->output, sizeof(tmp[1]));
            halfRate.process_block_D2(tmp[0], tmp[1], BLOCK_SIZE_OS);
            position = 0;
        }
        float value = 0;
        if (display)
        {
            for (int j = 0; j < averaging; ++j)
                value += tmp[0][position++];
            value /= averaging;
        }
        out += (i ? "," : "") + number(value);
    }
    o->~Oscillator();
    out += "],\"wavetable\":";
    out += uses_wavetabledata(oscdata->type.val.i) ? quote(oscdata->wavetable_display_name) : "null";
    return out + "}";
}

/** LFOAndStepDisplay::paintWaveform's evaluation: waveform and envelope over time. */
std::string renderLfo(SurgeSynthesizer &synth, const Json &request)
{
    long scene = 0, lfo = 0, points = 256;
    request.integer("points", points);
    if (!request.integer("scene", scene) || !request.integer("lfo", lfo) || scene < 0 ||
        scene >= n_scenes || lfo < 0 || lfo >= n_lfos || points < 8 || points > kMaxPoints)
        return error("renderLfo needs scene, lfo and 8..1024 points");
    auto *storage = &synth.storage;
    auto &patch = storage->getPatch();
    auto *lfodata = &patch.scene[scene].lfo[lfo];
    if (lfodata->shape.val.i == lt_formula)
        return error("formula modulators are not rendered");
    pdata tp[n_scene_params];
    for (auto *p : {&lfodata->delay, &lfodata->attack, &lfodata->hold, &lfodata->decay, &lfodata->sustain,
                    &lfodata->release, &lfodata->magnitude, &lfodata->rate, &lfodata->shape,
                    &lfodata->start_phase, &lfodata->deform})
        tp[p->param_id_in_scene].i = p->val.i;
    tp[lfodata->trigmode.param_id_in_scene].i = lm_keytrigger;

    const float dahd = std::pow(2.0f, lfodata->delay.val.f) + std::pow(2.0f, lfodata->attack.val.f) +
                       std::pow(2.0f, lfodata->hold.val.f) + std::pow(2.0f, lfodata->decay.val.f);
    float envelopeTime = dahd + std::min(std::pow(2.0f, lfodata->release.val.f), 4.f) + 0.5f;
    float rate = std::pow(2.0f, lfodata->rate.val.f);
    if (lfodata->rate.temposync)
        rate *= storage->temposyncratio;
    envelopeTime = std::min(envelopeTime, 50.f / rate);

    LFOModulationSource source;
    source.assign(storage, lfodata, tp, nullptr, &patch.stepsequences[scene][lfo], &patch.msegs[scene][lfo],
                  &patch.formulamods[scene][lfo], true);
    source.setIsVoice(lfo < n_lfos_voice);
    source.attack();

    const int blocks = std::max(int(points), int(envelopeTime * storage->samplerate / BLOCK_SIZE));
    const int averaging = std::max(1, blocks / int(points));
    const float magnitude = lfodata->magnitude.get_extended(lfodata->magnitude.val.f);
    int sustainCountdown = -1;
    std::string wave = "[", envelope = "[";
    int written = 0;
    for (int i = 0; i + averaging <= blocks && written < points; i += averaging, ++written)
    {
        float value = 0, env = 0;
        for (int s = 0; s < averaging; ++s)
        {
            source.process_block();
            if (sustainCountdown < 0 && source.env_state == lfoeg_stuck)
                sustainCountdown = int(0.5f * storage->samplerate / BLOCK_SIZE);
            else if (sustainCountdown == 0 && source.env_state == lfoeg_stuck)
                source.release();
            else if (sustainCountdown > 0)
                --sustainCountdown;
            value += source.get_output(0);
            env += source.env_val * magnitude;
        }
        wave += (written ? "," : "") + number(value / averaging);
        envelope += (written ? "," : "") + number(env / averaging);
    }
    const double seconds = double(written) * averaging * BLOCK_SIZE * storage->samplerate_inv;
    return "{\"wave\":" + wave + "],\"envelope\":" + envelope + "],\"seconds\":" + number(seconds) +
           ",\"unipolar\":" + (lfodata->unipolar.val.b ? "true" : "false") + "}";
}

/** Modulation sources, for the editor to map its source buttons. */
std::string sources()
{
    std::string out = "{\"sources\":[";
    for (int i = 0; i < n_modsources; ++i)
        out += std::string(i ? "," : "") + "{\"id\":" + number(i) + ",\"name\":" + quote(modsource_names[i]) +
               ",\"button\":" + quote(modsource_names_button[i]) + "}";
    return out + "]}";
}

std::string routing(SurgeSynthesizer &synth, const ModulationRouting &r, int scene)
{
    auto &patch = synth.storage.getPatch();
    const long ptag = scene < 0 ? r.destination_id : patch.scene_start[scene] + r.destination_id;
    const float depth = synth.getModDepth01(ptag, modsources(r.source_id), r.source_scene, r.source_index);
    return "{\"target\":" + number(ptag) + ",\"source\":" + number(r.source_id) + ",\"index\":" +
           number(r.source_index) + ",\"sourceScene\":" + number(r.source_scene) + ",\"scene\":" +
           number(scene) + ",\"depth\":" + number(depth) + ",\"muted\":" + (r.muted ? "true" : "false") + "}";
}

/** Every routing in the patch; scene routings report the scene they belong to. */
std::string modulation(SurgeSynthesizer &synth)
{
    auto &patch = synth.storage.getPatch();
    std::string out = "{\"routings\":[";
    bool first = true;
    auto add = [&](const std::vector<ModulationRouting> &list, int scene) {
        for (auto &r : list)
        {
            out += (first ? "" : ",") + routing(synth, r, scene);
            first = false;
        }
    };
    add(patch.modulation_global, -1);
    for (int scene = 0; scene < n_scenes; ++scene)
    {
        add(patch.scene[scene].modulation_scene, scene);
        add(patch.scene[scene].modulation_voice, scene);
    }
    return out + "]}";
}

/** setModDepth01 / clearModulation through Surge's own validation. */
std::string setModulation(SurgeSynthesizer &synth, const Json &request, bool clear)
{
    long target = -1, source = -1, index = 0, sourceScene = 0;
    request.integer("index", index);
    request.integer("sourceScene", sourceScene);
    if (!request.integer("target", target) || !request.integer("source", source) || !param(synth, target) ||
        source <= 0 || source >= n_modsources || index < 0 || index > 16 || sourceScene < 0 || sourceScene >= n_scenes)
        return error("modulation needs target, source, index and sourceScene");
    if (!synth.isValidModulation(target, modsources(source)))
        return error("this source cannot modulate this parameter");
    if (clear)
        synth.clearModulation(target, modsources(source), int(sourceScene), int(index), false);
    else
    {
        auto *depth = request.get("depth");
        if (!depth || depth->type != Json::Number)
            return error("setModulation needs depth");
        synth.setModDepth01(target, modsources(source), int(sourceScene), int(index),
                            float(std::clamp(depth->number, -1.0, 1.0)));
    }
    auto *p = param(synth, target);
    const float depth = synth.getModDepth01(target, modsources(source), int(sourceScene), int(index));
    char text[256] = {};
    p->get_display_of_modulation_depth(text, synth.getModDepth(target, modsources(source), int(sourceScene), int(index)),
                                       synth.isBipolarModulation(modsources(source)), Parameter::TypeIn);
    return "{\"depth\":" + number(depth) + ",\"active\":" +
           (synth.isActiveModulation(target, modsources(source), int(sourceScene), int(index)) ? "true" : "false") +
           ",\"text\":" + quote(text) + "}";
}

} // namespace

namespace surge_webvst
{

std::string handleMessage(SurgeSynthesizer &synth, const char *data, size_t size)
{
    Reader reader{data, data + size};
    Json request;
    if (!reader.read(request) || request.type != Json::Object)
        return error("request is not a JSON object");
    reader.space();
    if (reader.p != reader.end)
        return error("trailing data after request");
    const std::string type = request.str("type");
    if (type == "paramInfo")
        return paramInfo(synth, request);
    if (type == "parse")
        return parse(synth, request);
    if (type == "filterSubtypes")
        return filterSubtypes(synth, request);
    if (type == "renderOsc")
        return renderOsc(synth, request);
    if (type == "renderLfo")
        return renderLfo(synth, request);
    if (type == "sources")
        return sources();
    if (type == "modulation")
        return modulation(synth);
    if (type == "setModulation")
        return setModulation(synth, request, false);
    if (type == "clearModulation")
        return setModulation(synth, request, true);
    return error("unknown message type " + type);
}

} // namespace surge_webvst
