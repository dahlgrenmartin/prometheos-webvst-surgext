// GPL-3.0-or-later. Surge XT's JUCE editor ported to the WebVST UI toolkit.
//
// Layout comes from upstream SkinModel.cpp and slider styles from SurgePatch.cpp
// (see scripts/generate-ui.ts); artwork is the upstream dark-mode skin's SVGs,
// drawn with the same sprite offsets and clip regions the JUCE widgets use.
// Each class below names the upstream widget it replaces. Only presentation
// state (selected oscillator, LFO and FX slot, open menu) lives here; every
// synth value is a host parameter reached through ParameterAttachment.
#include <webvst/ui.h>
#include "surge_parameters.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <functional>
#include <iterator>
#include <memory>

namespace {
using namespace webvst;
using surge_ui::Binding;
using surge_ui::Connector;

// dark-mode.surge-skin palette.
constexpr const char* kLightGray = "#B4B4B4";
constexpr const char* kWhite = "#FFFFFF";
constexpr const char* kOrange = "#FF9300";
constexpr const char* kSurgeBlue = "#005CB6";
constexpr const char* kModBlue = "#2E86FE";
constexpr const char* kBgGray = "#242424";
constexpr const char* kButtonBg = "#151515";
constexpr const char* kFxGridGray = "#A0A0A0";
constexpr const char* kFont = "lato";
constexpr const char* kBold = "lato-bold";
constexpr double kDesignWidth = 905, kDesignHeight = 569;
constexpr double kPi = 3.141592653589793;

// JUCE font heights span ascent+descent, which is 1.2 em for Lato (hhea 1974/-426 of 2000).
double em(double juceHeight) { return juceHeight / 1.2; }
double ascent(double juceHeight) { return juceHeight * 1974.0 / 2400.0; }

std::string assetId(int resource) { char b[16]; std::snprintf(b, sizeof(b), "bmp%05d", resource); return b; }
const surge_ui::Asset* asset(int resource) {
    for (const auto& a : surge_ui::assets) if (a.resource == resource) return &a;
    return nullptr;
}

// SurgeImage::draw after translation and reduceClipRegion: the whole sheet, offset, clipped.
void sprite(Graphics& g, int resource, Rect clip, double offsetX, double offsetY) {
    const auto* a = asset(resource);
    if (!a) return;
    g.save();
    g.clip(clip);
    g.image(assetId(resource), {clip.x - offsetX, clip.y - offsetY, a->width, a->height});
    g.restore();
}
int spriteFrames(int resource, double frameHeight) {
    const auto* a = asset(resource);
    return a && frameHeight > 0 ? std::max(1, int(a->height / frameHeight + 0.01)) : 1;
}

std::string quote(const std::string& s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
        else if (c < 32) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
        else out += char(c);
    }
    return out + '"';
}
std::string number(double v) { char b[32]; std::snprintf(b, sizeof(b), "%.6g", std::isfinite(v) ? v : 0); return b; }
std::string semanticBase(const Component& c, const std::string& role, const std::string& label) {
    auto r = c.globalBounds();
    return "{\"id\":" + quote(c.id()) + ",\"role\":" + quote(role) + ",\"label\":" + quote(label) +
           ",\"bounds\":{\"x\":" + number(r.x) + ",\"y\":" + number(r.y) + ",\"width\":" + number(r.width) +
           ",\"height\":" + number(r.height) + "},\"disabled\":false";
}

bool startsWith(const std::string& s, const char* prefix) { return s.rfind(prefix, 0) == 0; }

// Surge labels scene/oscillator/LFO controls without their index prefix.
std::string shortName(const std::string& name) {
    for (const char* prefix : {"Filter EG ", "Amp EG "})
        if (startsWith(name, prefix)) return name.substr(std::string(prefix).size());
    for (const char* prefix : {"Scene LFO ", "LFO ", "Osc ", "Filter "}) {
        std::string p(prefix);
        if (startsWith(name, prefix) && name.size() > p.size() + 2 && std::isdigit(static_cast<unsigned char>(name[p.size()])) && name[p.size() + 1] == ' ')
            return name.substr(p.size() + 2);
    }
    return name;
}

const char* const kFxSlotNames[] = {"A Insert FX 1", "A Insert FX 2", "B Insert FX 1", "B Insert FX 2", "Send FX 1", "Send FX 2",
    "Global FX 1", "Global FX 2", "A Insert FX 3", "A Insert FX 4", "B Insert FX 3", "B Insert FX 4", "Send FX 3", "Send FX 4",
    "Global FX 3", "Global FX 4"};

// ---------------------------------------------------------------------------
// Parameter-bound widgets. One component per upstream connector; the editor
// rebinds it when the scene, oscillator, LFO or FX slot selection changes,
// exactly like SurgeGUIEditor re-running openOrRecreateEditor().
class Bound : public ParameterControl {
public:
    explicit Bound(const Connector& c) : ParameterControl(std::string("surge-") + c.id), connector(c) {
        setFocusable(true);
        setBounds({c.x, c.y, c.w, c.h});
    }
    ~Bound() override { attachment.reset(); }
    const Connector& connector;
    const Binding* binding = nullptr;
    std::function<void(Bound&)> openMenu;
    int fxSlot = 0;  // FX slot the FX type menu currently edits (for its label).

    void bind(Parameters& parameters, const Binding* b) {
        if (binding == b) return;
        attachment.reset();
        binding = b;
        if (b) {
            setLabel(b->name);
            attachment = std::make_unique<ParameterAttachment>(parameters, b->id, *this);
        }
        setVisible(b != nullptr);
        repaint();
    }
    int steps() const { return binding ? int(binding->steps) : 0; }
    int integer() const { const int n = steps(); return n > 0 ? std::clamp(int(std::lround(value() * n)), 0, n) : 0; }
    std::string choice(int i) const {
        if (!binding || binding->choices.empty()) return "";
        return binding->choices[std::min(binding->choices.size() - 1, size_t(std::max(0, i)))];
    }
    std::string choice() const { return choice(integer()); }
    void request(double v) {
        if (!attachment) return;
        attachment->begin();
        attachment->set(std::clamp(v, 0.0, 1.0));
        attachment->end();
    }
    void requestInteger(int i) { const int n = steps(); if (n > 0) request(double(std::clamp(i, 0, n)) / n); }
    std::string semantic() const override {
        if (!binding) return "";
        const std::string r = role();
        std::string s = semanticBase(*this, r, binding->name) + ",\"value\":" + number(value()) +
                        ",\"min\":0,\"max\":1,\"parameter\":" + quote(std::to_string(binding->id));
        if (r == "switch") s += std::string(",\"checked\":") + (value() >= .5 ? "true" : "false");
        if (r == "combobox" && !binding->choices.empty()) {
            s += ",\"choices\":[";
            for (size_t i = 0; i < binding->choices.size(); ++i) s += (i ? "," : "") + quote(binding->choices[i]);
            s += "]";
        }
        return s + "}";
    }

protected:
    // Wheel steps a notch; everything else keyboard/accessibility goes to ParameterControl.
    bool wheel(Event& e) {
        if (e.type != EventType::Wheel) return false;
        const double direction = e.deltaY < 0 || e.deltaX < 0 ? 1 : -1;
        if (steps() > 0) requestInteger(integer() + int(direction));
        else request(value() + direction * (e.shiftKey ? .001 : .01));
        e.stopPropagation();
        return true;
    }
    std::unique_ptr<ParameterAttachment> attachment;
};

// ModulatableSlider: tray and handle sprites, top-right label, relative drag.
class SurgeSlider final : public Bound {
public:
    using Bound::Bound;
    bool horizontal() const { return connector.orientation != 2; }
    double range() const { return horizontal() ? 112 : connector.mini ? 39 : 56; }
    void paint(Graphics& g) override {
        const double v = value();
        g.save();
        if (horizontal()) {
            g.translate(2, 5);
            const int row = (connector.semitone ? 2 : connector.bipolar ? 1 : 0) + (connector.white ? 3 : 0);
            sprite(g, 154, {0, 0, 133, 14}, 0, row * 14.0);
            g.text(shortName(label()), 121, 9 + ascent(9), em(9), kLightGray, kFont, Align::Right);
            const int cx = int(112 * v + 10.5), qx = cx - 10, qy = 6 - 7;
            sprite(g, 153, {qx - 2.0, qy - 2.0, 24, 19}, -1, -1);
        } else {
            g.translate(2, 2);
            const int row = connector.mini ? 2 : connector.bipolar ? 1 : 0;
            sprite(g, 105, {0, 0, 16, 75}, 0, row * 75.0);
            const int cy = int((1 - v) * range() + 9), qx = 0, qy = cy - 10;
            sprite(g, 157, {qx - 2.0, qy - 2.0, 19, 24}, -1, -1);
        }
        g.restore();
        if (hasFocus()) g.strokeRect({0.5, 0.5, bounds().width - 1, bounds().height - 1}, kModBlue, 1, 2);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !attachment) return;
        double x = 0, y = 0;
        toLocal(e.x, e.y, x, y);
        if (e.type == EventType::PointerDown && !dragging_) {
            dragging_ = true; pointer_ = e.pointerId; startX = x; startY = y; startValue = value();
            grabFocus(); capturePointer(pointer_); attachment->begin();
        } else if (e.type == EventType::PointerMove && dragging_ && e.pointerId == pointer_) {
            const double delta = (horizontal() ? x - startX : startY - y) / range();
            attachment->set(std::clamp(startValue + delta * (e.shiftKey ? .1 : 1), 0.0, 1.0));
        } else if ((e.type == EventType::PointerUp || e.type == EventType::PointerCancel) && dragging_ && e.pointerId == pointer_) {
            dragging_ = false; releasePointer(pointer_); attachment->end();
        } else if (!wheel(e)) {
            ParameterControl::onEvent(e);
        }
    }
private:
    double startX = 0, startY = 0, startValue = 0;
};

// MultiSwitch: vertical sprite frames selected by value; click selects by row/column.
class SurgeMultiSwitch final : public Bound {
public:
    using Bound::Bound;
    const char* role() const override { return "combobox"; }
    void paint(Graphics& g) override {
        const auto b = bounds();
        if (connector.background) sprite(g, connector.background, {0, 0, b.width, b.height}, 0, (connector.frameOffset + integer()) * b.height);
        if (hasFocus()) g.strokeRect({0.5, 0.5, b.width - 1, b.height - 1}, kModBlue, 1, 2);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !attachment) return;
        if (e.type == EventType::PointerDown) {
            double x = 0, y = 0;
            toLocal(e.x, e.y, x, y);
            const auto b = bounds();
            const int rows = std::max(1, connector.rows), columns = std::max(1, connector.columns), cells = rows * columns;
            const int mx = columns > 1 && rows < 2 ? int(x / (b.width / columns)) : 0;
            const int my = rows > 1 && columns < 2 ? int(y / (b.height / rows)) : 0;
            const int selection = std::clamp(my * columns + mx, 0, cells - 1);
            grabFocus();
            requestInteger(cells > 1 ? int(std::lround(double(selection) * steps() / (cells - 1))) : 0);
        } else if (!wheel(e)) {
            ParameterControl::onEvent(e);
        }
    }
};

// Switch: two frames, or one frame per integer value for multi-valued switches.
class SurgeSwitch final : public Bound {
public:
    using Bound::Bound;
    const char* role() const override { return steps() == 1 ? "switch" : "combobox"; }
    int frames() const { return std::min(steps() + 1, spriteFrames(connector.background, bounds().height)); }
    void paint(Graphics& g) override {
        const auto b = bounds();
        const int frame = steps() > 1 ? std::min(integer(), frames() - 1) : value() > .5 ? 1 : 0;
        if (connector.background) sprite(g, connector.background, {0, 0, b.width, b.height}, 0, frame * b.height);
        if (hasFocus()) g.strokeRect({0.5, 0.5, b.width - 1, b.height - 1}, kModBlue, 1, 1);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !attachment) return;
        if (e.type == EventType::PointerDown) {
            grabFocus();
            if (steps() > 1) requestInteger((integer() + 1) % std::max(1, frames()));
            else request(value() > .5 ? 0 : 1);
        } else if (!wheel(e)) {
            ParameterControl::onEvent(e);
        }
    }
};

// NumberField: background sprite, centred value text, vertical drag.
class SurgeNumberField final : public Bound {
public:
    using Bound::Bound;
    const char* role() const override { return "combobox"; }
    std::string display() const {
        auto text = choice();
        if (connector.background == 175) text = text.substr(0, text.find(' '));  // "2 semitones" -> "2"
        return text;
    }
    void paint(Graphics& g) override {
        const auto b = bounds();
        if (connector.background) sprite(g, connector.background, {0, 0, b.width, b.height}, 0, 0);
        g.text(display(), b.width / 2, b.height / 2 + ascent(9) / 2 - .5, em(9), hasFocus() ? kWhite : kLightGray, kFont, Align::Center);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !attachment) return;
        double x = 0, y = 0;
        toLocal(e.x, e.y, x, y);
        if (e.type == EventType::PointerDown && !dragging_) {
            dragging_ = true; pointer_ = e.pointerId; startY = y; startValue = integer();
            grabFocus(); capturePointer(pointer_); attachment->begin();
        } else if (e.type == EventType::PointerMove && dragging_ && e.pointerId == pointer_) {
            const int n = std::max(1, steps());
            attachment->set(double(std::clamp(startValue + int((startY - y) / 4), 0, n)) / n);
        } else if ((e.type == EventType::PointerUp || e.type == EventType::PointerCancel) && dragging_ && e.pointerId == pointer_) {
            dragging_ = false; releasePointer(pointer_); attachment->end();
        } else if (!wheel(e)) {
            ParameterControl::onEvent(e);
        }
    }
private:
    double startY = 0; int startValue = 0;
};

// MenuForDiscreteParams family: oscillator type, filter type, FX type, waveshaper.
class SurgeMenu final : public Bound {
public:
    using Bound::Bound;
    const char* role() const override { return "combobox"; }
    void paint(Graphics& g) override {
        const auto b = bounds();
        const auto text = choice();
        switch (connector.kind) {
        case surge_ui::K_OSCMENU: {
            sprite(g, 119, {0, 0, b.width, b.height}, 0, 0);
            std::string caps = text;
            for (auto& c : caps) c = char(std::toupper(static_cast<unsigned char>(c)));
            g.text(caps, b.width / 2 - 2, b.height / 2 + ascent(8) / 2 - 1, em(8), kLightGray, kBold, Align::Center);
            break;
        }
        case surge_ui::K_FILTERSELECTOR: {
            sprite(g, 168, {18, 2, 106, 18}, 0, 0);
            glyph(g, text, {1, 3, 16, 15});
            g.text(text, 24, 2 + 9 + ascent(9) / 2 - .5, em(9), kWhite, kFont);
            break;
        }
        case surge_ui::K_FXMENU: {
            sprite(g, 167, {0, 0, b.width, b.height}, 0, 0);
            g.text(kFxSlotNames[std::clamp(fxSlot, 0, 15)], 4, b.height / 2 + ascent(9) / 2 - .5, em(9), kLightGray, kFont);
            g.text(text, b.width - 14, b.height / 2 + ascent(9) / 2 - .5, em(9), kLightGray, kFont, Align::Right);
            break;
        }
        case surge_ui::K_WAVESHAPER: {
            sprite(g, 183, {0, 0, b.width, b.height}, 0, 0);
            g.text(text.size() > 7 ? text.substr(0, 7) : text, b.width / 2, 9, em(7), kLightGray, kFont, Align::Center);
            std::vector<std::pair<double, double>> curve;
            const int type = integer();
            for (int i = 0; i <= 24; ++i) {
                const double x = -1 + i / 12.0;
                double y = x;
                if (type > 0) y = std::tanh(x * (1.5 + (type % 7))) / std::tanh(1.5 + (type % 7));
                if (type % 5 == 3) y = std::sin(x * kPi * (1 + type % 3));
                curve.push_back({3 + (x + 1) * 14, 30 - y * 13});
            }
            g.strokePath(curve, kOrange, 1);
            break;
        }
        default:
            break;
        }
        if (hasFocus()) g.strokeRect({0.5, 0.5, b.width - 1, b.height - 1}, kModBlue, 1, 2);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !attachment) return;
        if (e.type == EventType::PointerDown) {
            grabFocus();
            if (openMenu) openMenu(*this);
        } else if (!wheel(e)) {
            ParameterControl::onEvent(e);
        }
    }
private:
    // Filter family glyph (upstream draws one of IDB_FILTER_ICONS; drawn as its curve here).
    static void glyph(Graphics& g, const std::string& name, Rect r) {
        std::vector<std::pair<double, double>> p;
        const bool lp = startsWith(name, "LP"), hp = startsWith(name, "HP"), bp = startsWith(name, "BP"), notch = startsWith(name, "N");
        for (int i = 0; i <= 16; ++i) {
            const double x = i / 16.0;
            double y = .5;
            if (lp) y = x < .55 ? .3 : .3 + (x - .55) * 1.4;
            else if (hp) y = x > .45 ? .3 : .3 + (.45 - x) * 1.4;
            else if (bp) y = .3 + std::min(1.0, std::abs(x - .5) * 1.6);
            else if (notch) y = std::abs(x - .5) < .12 ? .9 : .3;
            p.push_back({r.x + x * r.width, r.y + std::min(y, 1.0) * r.height});
        }
        if (name != "Off") g.strokePath(p, kLightGray, 1);
    }
};

// LFOAndStepDisplay: type selector sprite plus a rendered waveform and envelope.
class LfoDisplay final : public Bound {
public:
    explicit LfoDisplay(const Connector& c) : Bound(c) {}
    const char* role() const override { return "combobox"; }
    // Current LFO's other parameters, by upstream connector ID.
    std::function<double(const char*)> sibling;
    void paint(Graphics& g) override {
        const auto b = bounds();
        sprite(g, 166, {0, 4, 51, 76}, 0, integer() * 76.0);
        const Rect wave{69, 0, b.width - 71, b.height};
        g.rect(wave, kBgGray);
        g.line(wave.x, wave.y + wave.height / 2, wave.x + wave.width, wave.y + wave.height / 2, kButtonBg, 1);
        const double seconds = 5;
        auto time = [](double n) { return n <= 0.0001 ? 0.0 : std::pow(2.0, n * 13 - 8); };
        const double rate = std::pow(2.0, sibling("lfo.rate") * 16 - 7), phase = sibling("lfo.phase");
        const double amplitude = sibling("lfo.amplitude") * 2 - 1, deform = sibling("lfo.deform") * 2 - 1;
        const bool unipolar = sibling("lfo.unipolar") > .5;
        const double delay = time(sibling("lfo.delay")), attack = time(sibling("lfo.attack")), hold = time(sibling("lfo.hold"));
        const double decay = time(sibling("lfo.decay")), sustain = sibling("lfo.sustain"), release = time(sibling("lfo.release"));
        const double gate = std::min(seconds * .7, delay + attack + hold + decay + 1.5);
        auto envelope = [&](double t) {
            double level;
            if (t < delay) return 0.0;
            t -= delay;
            if (t < attack) level = t / std::max(attack, 1e-6);
            else if ((t -= attack) < hold) level = 1;
            else if ((t -= hold) < decay) level = 1 - (1 - sustain) * t / std::max(decay, 1e-6);
            else level = sustain;
            return level;
        };
        auto env = [&](double t) {
            if (t <= gate) return envelope(t);
            return envelope(gate) * std::max(0.0, 1 - (t - gate) / std::max(release, 1e-6));
        };
        auto hash = [](int i) { unsigned x = unsigned(i) * 2654435761u; x ^= x >> 13; x *= 0x5bd1e995u; x ^= x >> 15; return double(x & 0xffff) / 32767.5 - 1; };
        auto shape = [&](double t) {
            const double cycles = t * rate + phase;
            const double p = cycles - std::floor(cycles);
            switch (integer()) {
            case 0: return std::sin(2 * kPi * p) * (1 + deform * .3 * std::sin(4 * kPi * p));
            case 1: return 1 - 4 * std::abs(p - .5);
            case 2: return p < .5 + deform * .45 ? 1.0 : -1.0;
            case 3: return 2 * p - 1;
            case 4: { const int k = int(std::floor(cycles)); const double f = .5 - .5 * std::cos(kPi * p); return hash(k) * (1 - f) + hash(k + 1) * f; }
            case 5: return hash(int(std::floor(cycles)));
            case 6: return 1.0;
            case 7: return hash(int(std::floor(cycles * 16)) % 16);
            case 8: return 2 * p - 1;
            default: return std::sin(2 * kPi * p);
            }
        };
        std::vector<std::pair<double, double>> waveform, outline;
        const double centre = wave.y + wave.height / 2, scale = wave.height * .42;
        for (int i = 0; i <= 240; ++i) {
            const double t = seconds * i / 240.0, e = env(t);
            double v = shape(t) * amplitude;
            if (unipolar) v = (v + 1) / 2;
            const double x = wave.x + wave.width * i / 240.0;
            waveform.push_back({x, centre - v * e * scale});
            outline.push_back({x, centre - e * scale});
        }
        g.strokePath(outline, "#005CB680", 1);
        g.strokePath(waveform, kModBlue, 1);
        for (int i = 0; i <= 2; ++i)
            g.text(i == 0 ? "0 s" : i == 1 ? "2.5 s" : "5 s", wave.x + 2 + wave.width * i / 2 - (i == 2 ? 14 : i == 1 ? 8 : 0), wave.y + wave.height - 3, em(8), kLightGray, kFont);
        if (hasFocus()) g.strokeRect({0.5, 4.5, 50, 75}, kModBlue, 1, 2);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !attachment) return;
        if (e.type == EventType::PointerDown) {
            double x = 0, y = 0;
            toLocal(e.x, e.y, x, y);
            grabFocus();
            if (x < 51 && y >= 4 && y < 80) requestInteger(int((y - 4) / 15) * 2 + (x >= 25 ? 1 : 0));
        } else if (!wheel(e)) {
            ParameterControl::onEvent(e);
        }
    }
};

// ---------------------------------------------------------------------------
// Presentation-only widgets.

// Sprite drawn at its connector (status buttons, jogs, menus without a host service).
class Decoration final : public Component {
public:
    Decoration(const Connector& c) : Component(std::string("surge-") + c.id), connector(c) { setBounds({c.x, c.y, c.w, c.h}); }
    void paint(Graphics& g) override {
        if (connector.background) sprite(g, connector.background, {0, 0, bounds().width, bounds().height}, 0, connector.frameOffset * bounds().height);
    }
    const Connector& connector;
};

// Oscillator select 1/2/3: a MultiSwitch over editor view state.
class ViewSwitch final : public Component {
public:
    ViewSwitch(const Connector& c, std::vector<std::string> names) : Component(std::string("surge-") + c.id, "Oscillator"), connector(c), names(std::move(names)) {
        setBounds({c.x, c.y, c.w, c.h});
        setFocusable(true);
    }
    std::function<void(int)> onChange;
    int selected = 0;
    void paint(Graphics& g) override {
        sprite(g, connector.background, {0, 0, bounds().width, bounds().height}, 0, selected * bounds().height);
        if (hasFocus()) g.strokeRect({0.5, 0.5, bounds().width - 1, bounds().height - 1}, kModBlue, 1, 2);
    }
    void select(int i) { i = std::clamp(i, 0, int(names.size()) - 1); if (i != selected) { selected = i; repaint(); if (onChange) onChange(i); } }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target) return;
        const int n = int(names.size());
        if (e.type == EventType::PointerDown) {
            double x = 0, y = 0;
            toLocal(e.x, e.y, x, y);
            grabFocus();
            select(int(x / (bounds().width / n)));
        } else if (e.type == EventType::Change) {
            select(int(std::lround(e.value * (n - 1))));
        } else if (e.type == EventType::KeyDown) {
            if (e.key == "ArrowRight" || e.key == "ArrowUp") select(selected + 1);
            else if (e.key == "ArrowLeft" || e.key == "ArrowDown") select(selected - 1);
            else return;
            e.stopPropagation();
        }
    }
    std::string semantic() const override {
        std::string s = semanticBase(*this, "combobox", label()) + ",\"value\":" + number(names.size() > 1 ? double(selected) / (names.size() - 1) : 0) + ",\"min\":0,\"max\":1,\"choices\":[";
        for (size_t i = 0; i < names.size(); ++i) s += (i ? "," : "") + quote(names[i]);
        return s + "]}";
    }
private:
    const Connector& connector;
    std::vector<std::string> names;
};

// OscillatorWaveformDisplay: a period sketch of the current oscillator type and shape.
class OscDisplay final : public Component {
public:
    explicit OscDisplay(const Connector& c) : Component("surge-osc.display") { setBounds({c.x, c.y, c.w, c.h}); }
    std::function<int()> type;
    std::function<double(const char*)> sibling;
    void paint(Graphics& g) override {
        const auto b = bounds();
        const int t = type();
        const bool table = t == 2 || t == 7;
        const double shape = sibling("osc.param_1") * 2 - 1, width = sibling("osc.param_2");
        const double h = table ? b.height - 16 : b.height, centre = h / 2 + 2, amplitude = h * .38;
        auto hash = [](int i) { unsigned x = unsigned(i + 7) * 2654435761u; x ^= x >> 13; x *= 0x5bd1e995u; x ^= x >> 15; return double(x & 0xffff) / 32767.5 - 1; };
        std::vector<std::pair<double, double>> path;
        for (int i = 0; i <= 280; ++i) {
            const double cycles = 2.0 * i / 280, p = cycles - std::floor(cycles);
            double y;
            switch (t) {
            case 0: { const double saw = 2 * p - 1, pulse = p < .5 + (width - .5) * .9 ? 1 : -1; y = saw * (1 - std::abs(shape)) + pulse * std::abs(shape); break; }
            case 1: y = std::sin(2 * kPi * p); if (shape > 0) y = std::copysign(std::pow(std::abs(y), 1 - shape * .8), y); break;
            case 3: y = hash(int(std::floor(cycles * 12))) * .9; break;
            case 4: y = 0; break;
            case 5: case 6: y = std::sin(2 * kPi * p + (1 + shape) * 1.5 * std::sin(4 * kPi * p)); break;
            case 9: y = (2 * p - 1) * std::exp(-p * 2) * 1.4; break;
            case 10: y = std::sin(2 * kPi * p + std::sin(2 * kPi * p) * (1 + shape)); break;
            case 11: y = std::floor((2 * p - 1) * 6) / 6; break;
            default: y = std::sin(2 * kPi * p) * .8 + std::sin(6 * kPi * p) * .25 * shape + std::sin(10 * kPi * p) * .12; break;
            }
            path.push_back({2 + (b.width - 4) * i / 280.0, centre - std::clamp(y, -1.2, 1.2) * amplitude});
        }
        g.save();
        g.clip({0, 0, b.width, h + 4});
        g.strokePath(path, kOrange, 1.2);
        g.restore();
        if (table) {
            g.rect({2, b.height - 14, b.width - 4, 12}, kOrange);
            g.text("(Patch Wavetable)", b.width / 2, b.height - 5, em(9), "#000000", kFont, Align::Center);
            g.path({{6, b.height - 8}, {12, b.height - 12}, {12, b.height - 4}}, "#000000", true);
            g.path({{b.width - 6, b.height - 8}, {b.width - 12, b.height - 12}, {b.width - 12, b.height - 4}}, "#000000", true);
        }
    }
};

// EffectChooser: the 16-slot FX grid; selecting a slot retargets the FX type menu.
class EffectChooser final : public Component {
public:
    explicit EffectChooser(const Connector& c) : Component("surge-fx.selector", "FX slots") { setBounds({c.x, c.y, c.w, c.h}); setFocusable(true); }
    std::function<int(int)> fxType;
    std::function<void(int)> onSelect;
    int selected = 0;
    static Rect slot(int i) {
        const int row = (i / 2) % 4, num = i % 2 + 2 * (i >= 8);
        static const int rowYs[3] = {0, 45, 23};
        return row < 3 ? Rect{15.0 + num * 23, double(rowYs[row]), 19, 11} : Rect{120, num * 15.0, 19, 11};
    }
    void paint(Graphics& g) override {
        sprite(g, 137, {0, 0, bounds().width, bounds().height}, 0, 0);
        for (int s = 0; s < 2; ++s) {
            Rect r{4, s ? 45.0 : 0.0, 9, 11};
            g.strokeRect({r.x + .5, r.y + .5, r.width - 1, r.height - 1}, kFxGridGray, 1);
            g.text(s ? "B" : "A", r.x + r.width / 2, r.y + 8, em(7), kFxGridGray, kFont, Align::Center);
        }
        for (int i = 0; i < 16; ++i) {
            const auto r = slot(i);
            const char* color = i == selected ? kOrange : kFxGridGray;
            g.strokeRect({r.x + .5, r.y + .5, r.width - 1, r.height - 1}, color, 1);
            const int type = fxType(i);
            if (type == 0) g.rect({r.x + r.width / 2 - 2, r.y + r.height / 2, 6, 1}, color);
            else if (type > 0 && type < int(std::size(surge_ui::fxAcronyms)))
                g.text(surge_ui::fxAcronyms[type], r.x + r.width / 2, r.y + 8, em(7), color, kFont, Align::Center);
        }
        if (hasFocus()) g.strokeRect({0.5, 0.5, bounds().width - 1, bounds().height - 1}, kModBlue, 1, 2);
    }
    void select(int i) { i = (i + 16) % 16; if (i != selected) { selected = i; repaint(); if (onSelect) onSelect(i); } }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target) return;
        if (e.type == EventType::PointerDown) {
            double x = 0, y = 0;
            toLocal(e.x, e.y, x, y);
            grabFocus();
            for (int i = 0; i < 16; ++i) if (slot(i).contains(x, y)) select(i);
        } else if (e.type == EventType::Change) {
            select(int(std::lround(e.value * 15)));
        } else if (e.type == EventType::KeyDown) {
            if (e.key == "ArrowRight" || e.key == "ArrowDown") select(selected + 1);
            else if (e.key == "ArrowLeft" || e.key == "ArrowUp") select(selected - 1);
            else return;
            e.stopPropagation();
        }
    }
    std::string semantic() const override {
        std::string s = semanticBase(*this, "combobox", label()) + ",\"value\":" + number(selected / 15.0) + ",\"min\":0,\"max\":1,\"choices\":[";
        for (int i = 0; i < 16; ++i) s += (i ? "," : "") + quote(kFxSlotNames[i]);
        return s + "]}";
    }
};

// ModulationSourceButton look. LFO buttons choose which LFO the LFO panel edits.
struct ModStyle { const char* fill; const char* frame; const char* text; };
constexpr ModStyle kUnused{"#123463", "#205DB0", "#2E86FE"};
constexpr ModStyle kSelected{"#2364C0", "#90D8FF", "#90D8FF"};
void modButton(Graphics& g, Rect r, const std::string& text, const ModStyle& s, bool hamburger) {
    g.rect(r, s.fill);
    g.strokeRect({r.x + .5, r.y + .5, r.width - 1, r.height - 1}, s.frame, 1);
    if (hamburger)
        for (int i = 0; i < 3; ++i) g.rect({r.x + 4, r.y + 4 + i * 2.5, 6, 1}, s.text);
    g.text(text, r.x + r.width / 2 + (hamburger ? 4 : 0), r.y + 7 + ascent(9) / 2 - .5, em(9), s.text, kFont, Align::Center);
}

class ModButton final : public Component {
public:
    ModButton(int lfo, Rect r, std::string name) : Component("surge-modsource-" + std::to_string(lfo), std::move(name)), lfo(lfo) { setBounds(r); setFocusable(true); }
    const int lfo;
    std::function<void(int)> onSelect;
    std::function<bool(int)> isSelected;
    void paint(Graphics& g) override {
        modButton(g, {0, 0, bounds().width, bounds().height}, label(), isSelected(lfo) ? kSelected : kUnused, true);
        if (hasFocus()) g.strokeRect({0.5, 0.5, bounds().width - 1, bounds().height - 1}, kWhite, 1);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target) return;
        if (e.type == EventType::PointerDown || (e.type == EventType::KeyDown && (e.key == "Enter" || e.key == " "))) {
            grabFocus();
            if (onSelect) onSelect(lfo);
            e.stopPropagation();
        }
    }
    std::string semantic() const override { return semanticBase(*this, "button", "Edit " + label()) + "}"; }
};

class ModPanel final : public Component {
public:
    ModPanel() : Component("surge-modulation-panel") { setBounds({3, 402, 750, 72}); }
    static constexpr double x0 = 23, width = 72;
    void paint(Graphics& g) override {
        // "List" toggle column at the left of the panel.
        g.strokeRect({3.5, 0.5, 16, 70}, "#205DB0", 1);
        const char* list = "List";
        for (int i = 0; i < 4; ++i) g.text(std::string(1, list[i]), 11.5, 20 + i * 12, em(9), kModBlue, kFont, Align::Center);
        for (int i = 0; i < 8; ++i) {
            Rect r{x0 + i * 90, 0, 89, 22};
            modButton(g, {r.x, r.y, r.width, 14}, "Macro " + std::to_string(i + 1), kUnused, false);
            g.rect({r.x + 3, r.y + 16, r.width - 6, 4}, "#205DB0");
        }
        const char* row3[] = {"Velocity", "Release Velocity", "Poly AT", "Channel AT", "Pitch Bend", "Modwheel", "Breath", "Expression", "Sustain", "Timbre"};
        for (int i = 0; i < 10; ++i) modButton(g, {x0 + i * width, 24, width - 1, 14}, row3[i], kUnused, false);
        const char* row5[] = {"Filter EG", "Amp EG", "Random", "Alternate"};
        for (int i = 0; i < 4; ++i) modButton(g, {x0 + (6 + i) * width, 40, width - 1, 14}, row5[i], kUnused, false);
        const char* row7[] = {"Keytrack", "Lowest Key", "Highest Key", "Latest Key"};
        for (int i = 0; i < 4; ++i) modButton(g, {x0 + (6 + i) * width, 56, width - 1, 14}, row7[i], kUnused, false);
    }
};

// PatchSelector: the patch name area. Patch browsing stays with the host's program API.
// Case-insensitive ASCII substring match, as Surge's patch typeahead.
bool contains(const std::string& text, const std::string& query) {
    if (query.empty()) return true;
    auto lower = [](std::string s) { for (auto& c : s) c = char(std::tolower(static_cast<unsigned char>(c))); return s; };
    return lower(text).find(lower(query)) != std::string::npos;
}

// PatchSelector: current program name and category from the host's program service.
// Clicking the name opens the patch browser; the magnifier opens it for searching.
class PatchSelector final : public Component {
public:
    PatchSelector(const Connector& c, Programs& programs) : Component("surge-patch-browser", "Patch browser"), programs(programs) {
        setBounds({c.x, c.y, c.w, c.h});
        setFocusable(true);
    }
    std::function<void(bool search)> onOpen;
    void paint(Graphics& g) override {
        const auto b = bounds();
        sprite(g, 187, {4, 4, 13, 13}, 0, 0);
        sprite(g, 186, {b.width - 17, 4, 13, 13}, 0, 0);
        const bool known = programs.available() && !programs.name().empty();
        g.text(known ? programs.name() : "Surge XT", b.width / 2, 4 + ascent(13), em(13), hasFocus() ? "#D4D4D4" : kLightGray, kFont, Align::Center);
        if (known) {
            const auto& categories = programs.categories();
            g.text("Category: " + categories[size_t(programs.category())].name, 4, b.height - 3, em(9), kLightGray, kFont);
            g.text(std::to_string(programs.program() + 1) + " / " + std::to_string(categories[size_t(programs.category())].programs.size()),
                   b.width - 4, b.height - 3, em(9), kLightGray, kFont, Align::Right);
        }
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !programs.available()) return;
        if (e.type == EventType::PointerDown) {
            double x = 0, y = 0;
            toLocal(e.x, e.y, x, y);
            if (onOpen) onOpen(x < 22);
        } else if (e.type == EventType::KeyDown && (e.key == "Enter" || e.key == " ")) {
            if (onOpen) onOpen(false);
            e.stopPropagation();
        } else if (e.type == EventType::Wheel) {
            programs.step(e.deltaY > 0 ? 1 : -1);
            e.stopPropagation();
        }
    }
    std::string semantic() const override {
        return programs.available() ? semanticBase(*this, "button", "Patch: " + programs.name()) + "}" : "";
    }
private:
    Programs& programs;
};

// The category and patch prev/next jogs (upstream IDB_PREVNEXT_JOG).
class ProgramJog final : public Component {
public:
    ProgramJog(const Connector& c, Programs& programs, bool category)
        : Component(std::string("surge-") + c.id, category ? "category" : "patch"), connector(c), programs(programs), category(category) {
        setBounds({c.x, c.y, c.w, c.h});
    }
    void paint(Graphics& g) override {
        if (!programs.available()) g.setOpacity(.35);
        sprite(g, connector.background, {0, 0, bounds().width, bounds().height}, 0, 0);
        g.setOpacity(1);
    }
    void move(int delta) {
        if (!programs.available()) return;
        if (!category) { programs.step(delta); return; }
        const int n = int(programs.categories().size());
        programs.select(((std::max(0, programs.category()) + delta) % n + n) % n, 0);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || e.type != EventType::PointerDown) return;
        double x = 0, y = 0;
        toLocal(e.x, e.y, x, y);
        move(x < bounds().width / 2 ? -1 : 1);
    }
    std::string semantic() const override {
        return programs.available() ? semanticBase(*this, "button", std::string("Next ") + label()) + "}" : "";
    }
private:
    const Connector& connector;
    Programs& programs;
    const bool category;
};

// The patch browser: categories, their patches, and a typeahead search across all
// programs (upstream's patch menu plus PatchSelector's type-ahead).
class PatchBrowser final : public Component {
public:
    explicit PatchBrowser(Programs& programs) : Component("surge-patch-browser-panel", "Patch browser"), programs(programs) {
        setBounds({0, 0, kDesignWidth, kDesignHeight});
        setVisible(false);
        setFocusable(true);
    }
    bool isOpen() const { return visible(); }
    void open(bool search) {
        query.clear();
        category = std::max(0, programs.category());
        searching = search;
        rebuild();
        highlight = 0;
        for (size_t i = 0; i < results.size(); ++i)
            if (results[i].first == programs.category() && results[i].second == programs.program()) highlight = int(i);
        scrollTo(highlight);
        setVisible(true);
        grabFocus();
        repaint();
    }
    void close() { setVisible(false); }
    void paint(Graphics& g) override {
        g.save(); g.setOpacity(.35); g.rect({0, 0, kDesignWidth, kDesignHeight}, "#000000"); g.restore();
        g.rect(panel, "#202020");
        g.strokeRect({panel.x + .5, panel.y + .5, panel.width - 1, panel.height - 1}, "#0F0F0F", 1);
        // Search field.
        const Rect field{panel.x + 6, panel.y + 6, panel.width - 12, 18};
        g.rect(field, "#151515");
        g.strokeRect({field.x + .5, field.y + .5, field.width - 1, field.height - 1}, searching ? kOrange : "#4F4F4F", 1);
        sprite(g, 187, {field.x + 3, field.y + 2.5, 13, 13}, 0, 0);
        const double baseline = field.y + 9 + ascent(10) / 2 - .5;
        if (query.empty()) g.text(searching ? "Type to search all patches" : "Search", field.x + 20, baseline, em(10), "#808080", kFont);
        else g.text(query, field.x + 20, baseline, em(10), kLightGray, kFont);
        if (searching) {
            const double caret = field.x + 20 + query.size() * 5.2;
            g.line(caret, field.y + 4, caret, field.y + field.height - 4, kOrange, 1);
        }
        // Categories.
        const auto& categories = programs.categories();
        const double top = panel.y + 30, rows = std::floor((panel.height - 36) / kRow);
        for (size_t i = 0; i < categories.size() && i < rows; ++i) {
            const Rect r{panel.x + 6, top + i * kRow, 118, kRow};
            const bool current = int(i) == category && query.empty();
            if (current) g.rect(r, "#000000");
            g.text(categories[i].name, r.x + 4, r.y + kRow - 3.5, em(10), current ? kOrange : query.empty() ? kLightGray : "#808080", kFont);
        }
        g.line(panel.x + 128, top, panel.x + 128, panel.y + panel.height - 6, "#4F4F4F", 1);
        // Patches (of the category, or search results).
        for (int row = 0; row < int(rows) && scroll + row < int(results.size()); ++row) {
            const int i = scroll + row;
            const auto [c, p] = results[size_t(i)];
            const Rect r{panel.x + 132, top + row * kRow, panel.width - 138, kRow};
            if (i == highlight) g.rect(r, "#000000");
            const bool current = c == programs.category() && p == programs.program();
            g.text(categories[size_t(c)].programs[size_t(p)], r.x + 4, r.y + kRow - 3.5, em(10), current ? kOrange : kLightGray, kFont);
            if (!query.empty()) g.text(categories[size_t(c)].name, r.x + r.width - 4, r.y + kRow - 3.5, em(9), "#808080", kFont, Align::Right);
        }
        if (results.empty()) g.text("No patches match", panel.x + 136, top + kRow - 3.5, em(10), "#808080", kFont);
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !isOpen()) return;
        double x = 0, y = 0;
        toLocal(e.x, e.y, x, y);
        const double top = panel.y + 30;
        if (e.type == EventType::PointerDown) {
            if (!panel.contains(x, y)) { close(); return; }
            if (y < top) { searching = true; repaint(); return; }
            const int row = int((y - top) / kRow);
            if (x < panel.x + 128) {
                if (row >= 0 && size_t(row) < programs.categories().size()) { query.clear(); category = row; rebuild(); highlight = scroll = 0; searching = false; }
            } else if (scroll + row < int(results.size())) {
                choose(scroll + row);
                return;
            }
            repaint();
        } else if (e.type == EventType::Wheel) {
            scroll = std::clamp(scroll + (e.deltaY > 0 ? 3 : -3), 0, std::max(0, int(results.size()) - visibleRows()));
            repaint();
            e.stopPropagation();
        } else if (e.type == EventType::KeyDown) {
            key(e);
            e.stopPropagation();
        } else if (e.type == EventType::Blur) {
            close();
        }
    }
    std::string semantic() const override {
        if (!isOpen()) return "";
        std::string s = semanticBase(*this, "combobox", "Patch search: " + query) + ",\"value\":" +
                        number(results.size() > 1 ? double(highlight) / (results.size() - 1) : 0) + ",\"min\":0,\"max\":1,\"choices\":[";
        for (size_t i = 0; i < results.size() && i < 512; ++i)
            s += (i ? "," : "") + quote(programs.categories()[size_t(results[i].first)].programs[size_t(results[i].second)]);
        return s + "]}";
    }
private:
    void key(const Event& e) {
        const bool printable = e.key.size() == 1 ? e.key[0] >= 32 && e.key[0] < 127 : !e.key.empty() && static_cast<unsigned char>(e.key[0]) >= 0x80;
        if (e.key == "Escape") { if (query.empty()) close(); else { query.clear(); rebuild(); } }
        else if (e.key == "Enter") { if (highlight >= 0 && highlight < int(results.size())) choose(highlight); return; }
        else if (e.key == "ArrowDown") highlight = std::min(int(results.size()) - 1, highlight + 1);
        else if (e.key == "ArrowUp") highlight = std::max(0, highlight - 1);
        else if ((e.key == "ArrowLeft" || e.key == "ArrowRight") && query.empty()) {
            const int n = int(programs.categories().size());
            category = ((category + (e.key == "ArrowLeft" ? -1 : 1)) % n + n) % n;
            rebuild(); highlight = 0;
        } else if (e.key == "Backspace") {
            // Drop one UTF-8 code point.
            while (!query.empty() && (static_cast<unsigned char>(query.back()) & 0xC0) == 0x80) query.pop_back();
            if (!query.empty()) query.pop_back();
            rebuild();
        } else if (printable && !e.ctrlKey && !e.metaKey && query.size() < 64) {
            query += e.key; searching = true; rebuild(); highlight = 0;
        }
        scrollTo(highlight);
        repaint();
    }
    void rebuild() {
        results.clear();
        const auto& categories = programs.categories();
        for (size_t c = 0; c < categories.size(); ++c) {
            if (query.empty() && int(c) != category) continue;
            for (size_t p = 0; p < categories[c].programs.size(); ++p)
                if (query.empty() || contains(categories[c].programs[p], query) || contains(categories[c].name, query))
                    results.push_back({int(c), int(p)});
        }
        highlight = std::min(highlight, std::max(0, int(results.size()) - 1));
        scroll = std::min(scroll, std::max(0, int(results.size()) - visibleRows()));
    }
    int visibleRows() const { return int(std::floor((panel.height - 36) / kRow)); }
    void scrollTo(int i) {
        if (i < scroll) scroll = i;
        else if (i >= scroll + visibleRows()) scroll = i - visibleRows() + 1;
        scroll = std::max(0, scroll);
    }
    void choose(int i) {
        const auto [c, p] = results[size_t(i)];
        close();
        programs.select(c, p);
    }
    static constexpr double kRow = 14;
    Programs& programs;
    const Rect panel{157, 40, 390, 420};
    std::string query;
    std::vector<std::pair<int, int>> results;
    int category = 0, highlight = 0, scroll = 0;
    bool searching = false;
};

// VuMeter: empty meter frame (level telemetry is not part of the UI ABI yet).
class VuMeter final : public Component {
public:
    explicit VuMeter(const Connector& c) : Component("surge-vu") { setBounds({c.x, c.y, c.w, c.h}); }
    void paint(Graphics& g) override {
        const auto b = bounds();
        g.rect({0, 0, b.width, b.height}, "#0F0F0F");
        g.strokeRect({.5, .5, b.width - 1, b.height - 1}, "#202020", 1);
    }
};

// LFO title: the vertical "LFO n" label.
class LfoTitle final : public Component {
public:
    explicit LfoTitle(const Connector& c) : Component("surge-lfo.title") { setBounds({c.x, c.y, c.w, c.h}); }
    std::function<int()> lfo;
    void paint(Graphics& g) override {
        const int i = lfo();
        const std::string text = std::string(i >= 6 ? "SLFO" : "LFO") + std::to_string(i % 6 + 1);
        for (size_t k = 0; k < text.size(); ++k)
            g.text(std::string(1, text[k]), bounds().width / 2, 10 + k * 13.0, em(10), "#B4B4B490", kBold, Align::Center);
    }
};

// ---------------------------------------------------------------------------
// Popup menu for discrete parameters (juce::PopupMenu in the upstream editor).
class PopupMenu final : public Component {
public:
    PopupMenu() : Component("surge-popup-menu", "Menu") { setBounds({0, 0, kDesignWidth, kDesignHeight}); setVisible(false); setFocusable(true); }
    void open(Bound& control) {
        target = &control;
        const auto& choices = control.binding->choices;
        count = int(choices.size());
        perColumn = std::min(count, 22);
        columns = (count + perColumn - 1) / std::max(1, perColumn);
        const auto anchor = control.bounds();
        box = {anchor.x, anchor.y + anchor.height, columns * itemWidth + 4, perColumn * itemHeight + 4};
        box.x = std::clamp(box.x, 2.0, kDesignWidth - box.width - 2);
        if (box.y + box.height > kDesignHeight - 2) box.y = std::max(2.0, anchor.y - box.height);
        hover = control.integer();
        setVisible(true);
        grabFocus();
        repaint();
    }
    void close() { target = nullptr; setVisible(false); }
    void paint(Graphics& g) override {
        if (!target || !target->binding) return;
        g.save(); g.setOpacity(.35); g.rect({0, 0, kDesignWidth, kDesignHeight}, "#000000"); g.restore();
        g.rect(box, "#202020");
        g.strokeRect({box.x + .5, box.y + .5, box.width - 1, box.height - 1}, "#0F0F0F", 1);
        const int current = target->integer();
        for (int i = 0; i < count; ++i) {
            const auto r = item(i);
            if (i == hover) g.rect(r, kSurgeBlue);
            g.text(target->choice(i), r.x + 6, r.y + itemHeight - 3.5, em(9), i == current ? kOrange : i == hover ? kWhite : kLightGray, kFont);
        }
    }
    void onEvent(Event& e) override {
        if (e.phase != EventPhase::Target || !target) return;
        double x = 0, y = 0;
        toLocal(e.x, e.y, x, y);
        if (e.type == EventType::PointerMove) {
            const int i = at(x, y);
            if (i >= 0 && i != hover) { hover = i; repaint(); }
        } else if (e.type == EventType::PointerDown) {
            const int i = at(x, y);
            auto* chosen = target;
            close();
            if (i >= 0) chosen->requestInteger(i);
        } else if (e.type == EventType::KeyDown) {
            if (e.key == "Escape") close();
            else if (e.key == "ArrowDown") hover = std::min(count - 1, hover + 1);
            else if (e.key == "ArrowUp") hover = std::max(0, hover - 1);
            else if (e.key == "Enter" || e.key == " ") { auto* chosen = target; const int i = hover; close(); chosen->requestInteger(i); }
            repaint();
            e.stopPropagation();
        } else if (e.type == EventType::Blur) {
            close();
        }
    }
    std::string semantic() const override { return ""; }
private:
    Rect item(int i) const { return {box.x + 2 + (i / perColumn) * itemWidth, box.y + 2 + (i % perColumn) * itemHeight, itemWidth, itemHeight}; }
    int at(double x, double y) const { for (int i = 0; i < count; ++i) if (item(i).contains(x, y)) return i; return -1; }
    static constexpr double itemWidth = 112, itemHeight = 13;
    Bound* target = nullptr;
    Rect box;
    int count = 0, perColumn = 1, columns = 1, hover = 0;
};

// ---------------------------------------------------------------------------
// The 905x569 editor frame (SurgeGUIEditor's main frame).
class Frame final : public Component {
public:
    explicit Frame(Parameters& p) : Component("surge-frame"), parameters(p) {
        for (const auto& b : surge_ui::bindings) parameters.define({b.id, b.initial, b.steps, false, b.name, b.choices});
        const auto connector = [](const char* id) -> const Connector& {
            for (const auto& c : surge_ui::connectors) if (std::string(c.id) == id) return c;
            return surge_ui::connectors[0];
        };
        // Decorations first so bound controls paint (and hit test) above them.
        for (const char* id : {"controls.status.mpe", "controls.status.tune", "controls.status.zoom", "controls.patch.save", "controls.action.undo",
                               "controls.action.redo", "controls.surge_menu",
                               "lfo.presets", "lfo.mseg_editor", "filter.filter_preview", "filter.waveshaper_preview",
                               "filter.waveshaper_prevnext", "fx.preset.prevnext"})
            decorations.push_back(std::make_unique<Decoration>(connector(id)));
        for (auto& d : decorations) addAndMakeVisible(*d);
        auto& programs = parameters.programs();
        patch = std::make_unique<PatchSelector>(connector("controls.patch_browser"), programs);
        categoryJog = std::make_unique<ProgramJog>(connector("controls.category.prevnext"), programs, true);
        patchJog = std::make_unique<ProgramJog>(connector("controls.patch.prevnext"), programs, false);
        browser = std::make_unique<PatchBrowser>(programs);
        patch->onOpen = [this](bool search) { menu.close(); browser->open(search); };
        addAndMakeVisible(*categoryJog);
        addAndMakeVisible(*patchJog);
        programs.listen([this] { repaint(); });
        vu = std::make_unique<VuMeter>(connector("controls.vu_meter"));
        oscDisplay = std::make_unique<OscDisplay>(connector("osc.display"));
        lfoTitle = std::make_unique<LfoTitle>(connector("lfo.title"));
        effects = std::make_unique<EffectChooser>(connector("fx.selector"));
        oscSelect = std::make_unique<ViewSwitch>(connector("osc.select"), std::vector<std::string>{"Oscillator 1", "Oscillator 2", "Oscillator 3"});
        modPanel = std::make_unique<ModPanel>();
        for (auto* c : std::initializer_list<Component*>{patch.get(), vu.get(), oscDisplay.get(), lfoTitle.get(), effects.get(), oscSelect.get(), modPanel.get()})
            addAndMakeVisible(*c);
        for (int i = 0; i < 12; ++i) {
            const int row = i < 6 ? 5 : 7;
            auto button = std::make_unique<ModButton>(i, Rect{ModPanel::x0 + (i % 6) * ModPanel::width, 8.0 * row, ModPanel::width - 1, 14},
                                                      std::string(i < 6 ? "LFO " : "S-LFO ") + std::to_string(i % 6 + 1));
            button->onSelect = [this](int lfo) { selectLfo(lfo); };
            button->isSelected = [this](int lfo) { return lfo == lfo_; };
            modPanel->addAndMakeVisible(*button);
            modButtons.push_back(std::move(button));
        }

        // One control per connector that edits a parameter.
        std::vector<int> seen;
        for (const auto& b : surge_ui::bindings) {
            if (std::find(seen.begin(), seen.end(), b.connector) != seen.end()) continue;
            seen.push_back(b.connector);
            const auto& c = surge_ui::connectors[b.connector];
            std::unique_ptr<Bound> control;
            switch (c.kind) {
            case surge_ui::K_SLIDER: control = std::make_unique<SurgeSlider>(c); break;
            case surge_ui::K_MULTISWITCH: control = std::make_unique<SurgeMultiSwitch>(c); break;
            case surge_ui::K_SWITCH: control = std::make_unique<SurgeSwitch>(c); break;
            case surge_ui::K_NUMBERFIELD: control = std::make_unique<SurgeNumberField>(c); break;
            case surge_ui::K_LFODISPLAY: {
                auto display = std::make_unique<LfoDisplay>(c);
                display->sibling = [this](const char* id) { return current(id); };
                control = std::move(display);
                break;
            }
            default: control = std::make_unique<SurgeMenu>(c); break;
            }
            control->openMenu = [this](Bound& target) { if (target.binding && !target.binding->choices.empty()) menu.open(target); };
            addAndMakeVisible(*control);
            controls.push_back(std::move(control));
        }
        addAndMakeVisible(*browser);
        addAndMakeVisible(menu);
        // Overlays are children from the start (topmost for hit testing) but begin closed.
        browser->close();
        menu.close();

        oscDisplay->type = [this] { return int(std::lround(current("osc.type") * 11)); };
        oscDisplay->sibling = [this](const char* id) { return current(id); };
        lfoTitle->lfo = [this] { return lfo_; };
        oscSelect->onChange = [this](int osc) { osc_ = osc; rebind(); };
        effects->onSelect = [this](int slot) { fx_ = slot; rebind(); };
        effects->fxType = [this](int slot) {
            for (const auto& b : surge_ui::bindings)
                if (b.index == slot && std::string(surge_ui::connectors[b.connector].id) == "fx.type")
                    return int(std::lround(parameters.get(b.id) * b.steps));
            return 0;
        };
        // The scene shown follows the canonical Active Scene parameter, as upstream.
        for (const auto& b : surge_ui::bindings)
            if (std::string(surge_ui::connectors[b.connector].id) == "global.active_scene") activeScene = b.id;
        parameters.listen([this](uint32_t id, double value) {
            if (id == activeScene && (value >= .5 ? 1 : 0) != scene_) { scene_ = value >= .5 ? 1 : 0; rebind(); }
        });
        rebind();
    }
    void paint(Graphics& g) override { sprite(g, 102, {0, 0, kDesignWidth, kDesignHeight}, 0, 0); }
    void selectLfo(int lfo) { lfo_ = std::clamp(lfo, 0, 11); rebind(); }

private:
    // Canonical value of the bound parameter currently shown at `connector`.
    double current(const char* connector) const {
        for (const auto& c : controls)
            if (std::string(c->connector.id) == connector && c->binding) return parameters.get(c->binding->id);
        return 0;
    }
    bool matches(const Binding& b, const std::string& id) const {
        if (b.scene >= 0 && b.scene != scene_) return false;
        if (b.index < 0) return true;
        if (startsWith(id, "osc.")) return b.index == osc_;
        if (startsWith(id, "lfo.")) return b.index == lfo_;
        if (id == "fx.type") return b.index == fx_;
        return true;
    }
    void rebind() {
        menu.close();
        const bool upperSends = fx_ >= 8;  // Stacked send/return pairs follow the FX slot.
        for (auto& c : controls) {
            const std::string id = c->connector.id;
            const Binding* found = nullptr;
            for (const auto& b : surge_ui::bindings)
                if (&surge_ui::connectors[b.connector] == &c->connector && matches(b, id)) { found = &b; break; }
            c->bind(parameters, found);
            c->fxSlot = fx_;
            const bool lower = id == "scene.send_fx_1" || id == "scene.send_fx_2" || id == "global.fx1_return" || id == "global.fx2_return";
            const bool upper = id == "scene.send_fx_3" || id == "scene.send_fx_4" || id == "global.fx3_return" || id == "global.fx4_return";
            if (lower || upper) c->setVisible(found && (upper == upperSends));
        }
        repaint();
    }

    Parameters& parameters;
    std::vector<std::unique_ptr<Decoration>> decorations;
    std::unique_ptr<PatchSelector> patch;
    std::unique_ptr<ProgramJog> categoryJog, patchJog;
    std::unique_ptr<PatchBrowser> browser;
    std::unique_ptr<VuMeter> vu;
    std::unique_ptr<OscDisplay> oscDisplay;
    std::unique_ptr<LfoTitle> lfoTitle;
    std::unique_ptr<EffectChooser> effects;
    std::unique_ptr<ViewSwitch> oscSelect;
    std::unique_ptr<ModPanel> modPanel;
    std::vector<std::unique_ptr<ModButton>> modButtons;
    std::vector<std::unique_ptr<Bound>> controls;
    PopupMenu menu;
    uint32_t activeScene = 0;
    int scene_ = 0, osc_ = 0, lfo_ = 0, fx_ = 0;
};

// Scales the fixed upstream design to the host's editor size, as Surge's zoom does.
class SurgeEditor final : public Component {
public:
    explicit SurgeEditor(Parameters& parameters) : Component("surge-editor", "Surge XT"), frame(parameters) { addAndMakeVisible(frame); }
    void resized() override {
        const auto b = bounds();
        double zoom = std::min(b.width / kDesignWidth, b.height / kDesignHeight);
        if (!(zoom > 0)) zoom = 1;
        setContentScale(zoom);
        frame.setBounds({(b.width / zoom - kDesignWidth) / 2, (b.height / zoom - kDesignHeight) / 2, kDesignWidth, kDesignHeight});
    }
    void paint(Graphics& g) override { g.rect({0, 0, bounds().width, bounds().height}, "#000000"); }
private:
    Frame frame;
};
}  // namespace

std::unique_ptr<webvst::Component> webvst::createEditor(Parameters& parameters) {
    return std::make_unique<SurgeEditor>(parameters);
}
