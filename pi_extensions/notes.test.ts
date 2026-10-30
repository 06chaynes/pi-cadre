import assert from "node:assert/strict";
import { test } from "node:test";

import { ungroundedParts } from "./notes.ts";

const source = [
  "The 2020 China-Nepal survey measured Mount Everest at 8,848.86 metres.",
  "URL: https://www.cma.gov.cn/en2014/news/everest.html",
  'Release notes: "This is a free minix-like kernel for i386(+) based AT-machines."',
].join("\n");

test("a note's numbers, URLs, and quotes that appear in the sources are grounded", () => {
  assert.deepEqual(ungroundedParts('Everest: 8,848.86 m (2020 survey). "This is a free minix-like kernel for i386(+) based AT-machines."', source), []);
  assert.deepEqual(ungroundedParts("Everest 8848.86 m https://www.cma.gov.cn/en2014/news/everest.html/", source), []);
});

test("a number, URL, or quote the sources do not contain is reported", () => {
  // The real failure: a note added "7,749.21 m above sea level", which no result contained.
  assert.deepEqual(ungroundedParts("Everest: 8,848.86 m (7,749.21 m above sea level). https://www.cma.gov.cn/en2014/news/everest.html", source), ["7,749.21"]);
  assert.deepEqual(ungroundedParts("Everest 8,848.86 m https://example.org/everest", source), ["https://example.org/everest"]);
  assert.deepEqual(ungroundedParts('Linux: "This is a free unix-like kernel for all machines."', source), ['"This is a free unix-like kernel for all machines."']);
});

test("single digits and words without numbers are not checked", () => {
  assert.deepEqual(ungroundedParts("Everest is the highest mountain; 2 surveys agree.", source), []);
});
