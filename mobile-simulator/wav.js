const TARGET_SAMPLE_RATE = 16_000;

export function mergeFloat32Chunks(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function resampleMono(input, inputRate, outputRate = TARGET_SAMPLE_RATE) {
  if (!(input instanceof Float32Array)) throw new TypeError("input must be Float32Array");
  if (inputRate <= 0 || outputRate <= 0) throw new RangeError("sample rates must be positive");
  if (inputRate === outputRate) return input.slice();

  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = index * ratio;
    const end = Math.min((index + 1) * ratio, input.length);
    const first = Math.floor(start);
    const last = Math.max(first + 1, Math.ceil(end));
    let sum = 0;
    let weight = 0;

    for (let sourceIndex = first; sourceIndex < last && sourceIndex < input.length; sourceIndex += 1) {
      const overlap = Math.max(0, Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex));
      sum += input[sourceIndex] * overlap;
      weight += overlap;
    }
    output[index] = weight ? sum / weight : 0;
  }
  return output;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function encodePcm16Wav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    const pcm = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    view.setInt16(offset, Math.round(pcm), true);
    offset += bytesPerSample;
  }
  return buffer;
}

export function createWavBlob(chunks, inputRate, maxDurationSeconds = Number.POSITIVE_INFINITY) {
  const merged = mergeFloat32Chunks(chunks);
  let resampled = resampleMono(merged, inputRate, TARGET_SAMPLE_RATE);
  if (Number.isFinite(maxDurationSeconds)) {
    resampled = resampled.slice(0, Math.floor(maxDurationSeconds * TARGET_SAMPLE_RATE));
  }
  return {
    blob: new Blob([encodePcm16Wav(resampled)], { type: "audio/wav" }),
    sampleCount: resampled.length,
    durationSeconds: resampled.length / TARGET_SAMPLE_RATE,
  };
}

export { TARGET_SAMPLE_RATE };
