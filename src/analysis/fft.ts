/**
 * Iterative radix-2 FFT, in place, allocation-light.
 *
 * Why hand-rolled: the offline analyser needs magnitudes for a few thousand
 * frames per track. A dependency would be another thing to keep alive for 60
 * lines of butterfly loops.
 */

export function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size <<= 1;
  return size;
}

/** Hann window: side lobes low enough that chroma mapping stays clean. */
export function hannWindow(size: number, cache = new Map<number, Float64Array>()): Float64Array {
  const cached = cache.get(size);
  if (cached) return cached;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  cache.set(size, window);
  return window;
}

/**
 * In-place complex FFT. `real`/`imag` must have the same power-of-two length.
 * Bit-reversal permutation first, then log2(n) butterfly stages.
 */
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n <= 1 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  if (imag.length !== n) throw new Error('FFT buffers must have equal length');

  // Bit reversal
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const realTemp = real[i] ?? 0;
      real[i] = real[j] ?? 0;
      real[j] = realTemp;
      const imagTemp = imag[i] ?? 0;
      imag[i] = imag[j] ?? 0;
      imag[j] = imagTemp;
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wRealStep = Math.cos(angle);
    const wImagStep = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wReal = 1;
      let wImag = 0;
      const half = length >> 1;
      for (let k = 0; k < half; k += 1) {
        const evenIndex = start + k;
        const oddIndex = evenIndex + half;
        const oddReal = (real[oddIndex] ?? 0) * wReal - (imag[oddIndex] ?? 0) * wImag;
        const oddImag = (real[oddIndex] ?? 0) * wImag + (imag[oddIndex] ?? 0) * wReal;
        const evenReal = real[evenIndex] ?? 0;
        const evenImag = imag[evenIndex] ?? 0;
        real[evenIndex] = evenReal + oddReal;
        imag[evenIndex] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;
        const nextWReal = wReal * wRealStep - wImag * wImagStep;
        wImag = wReal * wImagStep + wImag * wRealStep;
        wReal = nextWReal;
      }
    }
  }
}

/** Magnitude spectrum for bins 0..n/2 of a real frame. */
export function magnitudeSpectrum(frame: Float64Array, window?: Float64Array): Float64Array {
  const n = frame.length;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    real[i] = (frame[i] ?? 0) * (window ? window[i] ?? 1 : 1);
  }
  fftInPlace(real, imag);
  const bins = n >> 1;
  const magnitudes = new Float64Array(bins);
  for (let bin = 0; bin < bins; bin += 1) {
    magnitudes[bin] = Math.hypot(real[bin] ?? 0, imag[bin] ?? 0);
  }
  return magnitudes;
}

/** Frequency in Hz for a bin index. */
export function binFrequency(bin: number, fftSize: number, sampleRate: number): number {
  return (bin * sampleRate) / fftSize;
}
