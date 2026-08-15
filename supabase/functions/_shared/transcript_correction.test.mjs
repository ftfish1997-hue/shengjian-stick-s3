import assert from "node:assert/strict";
import test from "node:test";
import { cleanTranscript } from "./transcript_correction.ts";

test("normalizes whitespace without changing the source string", () => {
  const rawText = "  明天   提醒我买锌片。  ";

  assert.equal(cleanTranscript(rawText), "明天 提醒我买锌片。");
  assert.equal(rawText, "  明天   提醒我买锌片。  ");
});

test("corrects the observed zinc supplement homophone in consumption context", () => {
  assert.equal(
    cleanTranscript("嗯，提醒我晚上十点吃一个这个芯片。"),
    "嗯，提醒我晚上十点吃一个这个锌片。",
  );
  assert.equal(cleanTranscript("饭后服用一片芯片。"), "饭后服用一片锌片。");
  assert.equal(cleanTranscript("最近需要补充芯片。"), "最近需要补充锌片。");
});

test("preserves legitimate technical uses of 芯片", () => {
  assert.equal(
    cleanTranscript("记录一下这个芯片的待机功耗。"),
    "记录一下这个芯片的待机功耗。",
  );
  assert.equal(
    cleanTranscript("我想到一个芯片散热方案。"),
    "我想到一个芯片散热方案。",
  );
});

test("does not cross punctuation boundaries to force a correction", () => {
  assert.equal(
    cleanTranscript("先吃点东西，再检查这个芯片。"),
    "先吃点东西，再检查这个芯片。",
  );
});
