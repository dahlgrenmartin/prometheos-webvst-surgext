#pragma once

#include <cstddef>
#include <string>

class SurgeSynthesizer;

namespace surge_webvst
{

/**
 * The `webvst-ext-message-1` handlers: requests from this plugin's own editor
 * for things only the running synth knows (value text, dynamic parameter
 * names, filter subtypes, oscillator/LFO display rendering, modulation
 * routing). Request and reply are UTF-8 JSON; failures are `{"error":...}`
 * replies, never traps. Called between process blocks.
 */
std::string handleMessage(SurgeSynthesizer &synth, const char *request, size_t size);

} // namespace surge_webvst
