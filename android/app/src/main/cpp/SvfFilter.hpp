// SvfFilter.hpp — topology-preserving state variable filter.
//
// Chosen over a biquad because a DJ sweeps the cutoff: TPT stays stable and
// click-free while the coefficient changes every block, where a direct-form
// biquad can pop or blow up on fast modulation.

#pragma once

#include <cmath>

namespace auragrid {

class SvfFilter {
 public:
  enum class Mode : int { kLowpass = 0, kHighpass = 1 };

  void prepare(double sampleRate) {
    sampleRate_ = sampleRate > 0 ? sampleRate : 48000.0;
    reset();
  }

  void reset() {
    ic1eq_ = 0.0;
    ic2eq_ = 0.0;
  }

  void setCutoff(float normalised) {
    // 0..1 → 30 Hz .. 18 kHz, exponential. Linear would waste the whole travel
    // below 2 kHz where nobody wants resolution.
    const double clamped = normalised < 0.0f ? 0.0 : (normalised > 1.0f ? 1.0f : normalised);
    const double minHz = 30.0;
    const double maxHz = 18000.0;
    const double hz = minHz * std::pow(maxHz / minHz, clamped);
    updateCoefficients(hz);
  }

  void setResonance(float normalised) {
    const double q = 0.5 + static_cast<double>(normalised < 0.0f ? 0.0f : (normalised > 1.0f ? 1.0f : normalised)) * 9.5;
    k_ = 1.0 / q;
  }

  void setMode(Mode mode) { mode_ = mode; }
  Mode mode() const { return mode_; }

  float process(float input) {
    const double v0 = input;
    const double v3 = v0 - ic2eq_;
    const double v1 = a1_ * ic1eq_ + a2_ * v3;
    const double v2 = ic2eq_ + a2_ * ic1eq_ + a3_ * v3;
    ic1eq_ = 2.0 * v1 - ic1eq_;
    ic2eq_ = 2.0 * v2 - ic2eq_;
    const double low = v2;
    const double high = v0 - k_ * v1 - v2;
    return static_cast<float>(mode_ == Mode::kLowpass ? low : high);
  }

 private:
  void updateCoefficients(double hz) {
    const double nyquist = sampleRate_ * 0.5;
    const double capped = hz > nyquist * 0.92 ? nyquist * 0.92 : hz;
    const double g = std::tan(3.14159265358979323846 * capped / sampleRate_);
    a1_ = 1.0 / (1.0 + g * (g + k_));
    a2_ = g * a1_;
    a3_ = g * a2_;
  }

  double sampleRate_ = 48000.0;
  double k_ = 2.0;
  double a1_ = 0.0;
  double a2_ = 0.0;
  double a3_ = 0.0;
  double ic1eq_ = 0.0;
  double ic2eq_ = 0.0;
  Mode mode_ = Mode::kLowpass;
};

/**
 * Soft-knee limiter; tanh shape, no lookahead latency.
 *
 * The tanh curve alone can exceed full scale above unity input (+0.7 dB at
 * drive 1.6), and an overshoot past 1.0 is exactly what the AudioFlinger mixer
 * turns into a hard clip. So the soft knee is followed by a hard ceiling: the
 * shape stays musical, the level stays legal.
 */
inline float softClip(float x, float drive) {
  const float d = drive < 1.0f ? 1.0f : drive;
  const float shaped = std::tanh(x * d) / std::tanh(d);
  return shaped > 1.0f ? 1.0f : (shaped < -1.0f ? -1.0f : shaped);
}

}  // namespace auragrid
