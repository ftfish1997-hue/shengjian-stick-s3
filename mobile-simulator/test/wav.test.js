import test from "node:test";
import assert from "node:assert/strict";
import { encodePcm16Wav, mergeFloat32Chunks, resampleMono } from "../wav.js";

test("merges captured chunks in order", () => {
  const merged = mergeFloat32Chunks([new Float32Array([0, 0.5]), new Float32Array([-0.5, 1])]);
  assert.deepEqual([...merged], [0, 0.5, -0.5, 1]);
});

test("resamples 48 kHz mono audio to 16 kHz", () => {
  const input = new Float32Array(48_000).fill(0.25);
  const output = resampleMono(input, 48_000, 16_000);
  assert.equal(output.length, 16_000);
  assert.ok(Math.abs(output[10] - 0.25) < 1e-6);
});

test("encodes a readable 16-bit mono WAV header", () => {
  const wav = encodePcm16Wav(new Float32Array(16_000), 16_000);
  const view = new DataView(wav);
  const ascii = (offset, length) => String.fromCharCode(...new Uint8Array(wav, offset, length));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 32_000);
});
