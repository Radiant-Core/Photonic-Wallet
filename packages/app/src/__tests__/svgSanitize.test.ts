/**
 * R13 — SVG sanitisation must strip every code-execution vector before
 * bytes go on-chain. These tests pin the contract for what the mint
 * pipeline (Mint.tsx::onDrop) feeds DOMPurify.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeSvgString,
  sanitizeSvgBytes,
  looksLikeSvg,
} from "@app/svgSanitize";

describe("R13 — looksLikeSvg", () => {
  it("detects a bare <svg> root", () => {
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    expect(looksLikeSvg(bytes)).toBe(true);
  });

  it("detects an XML-declared SVG", () => {
    const bytes = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    );
    expect(looksLikeSvg(bytes)).toBe(true);
  });

  it("returns false for unrelated XML", () => {
    const bytes = new TextEncoder().encode(
      '<?xml version="1.0"?><note>plain</note>'
    );
    expect(looksLikeSvg(bytes)).toBe(false);
  });

  it("returns false for binary PNG headers", () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(looksLikeSvg(bytes)).toBe(false);
  });

  it("tolerates a UTF-8 BOM prefix", () => {
    const bytes = new TextEncoder().encode(
      '﻿<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    expect(looksLikeSvg(bytes)).toBe(true);
  });
});

describe("R13 — sanitizeSvgString strips XSS payloads", () => {
  it("removes <script> blocks", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
      <script>alert('xss')</script>
      <rect width="10" height="10" fill="red"/>
    </svg>`;
    const out = sanitizeSvgString(malicious);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
    // Benign content survives.
    expect(out).toContain("rect");
  });

  it("strips on* event handlers", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect width="10" height="10" onload="alert(1)" onclick="alert(2)"/>
    </svg>`;
    const out = sanitizeSvgString(malicious);
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert");
  });

  it("removes <foreignObject> (HTML smuggled into SVG)", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <foreignObject width="100" height="100">
        <body xmlns="http://www.w3.org/1999/xhtml">
          <script>alert('foreign')</script>
        </body>
      </foreignObject>
    </svg>`;
    const out = sanitizeSvgString(malicious);
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
  });

  it("removes <a> hyperlinks (no remote nav from rendered NFT)", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <a href="https://evil.example/phish"><rect width="10" height="10"/></a>
    </svg>`;
    const out = sanitizeSvgString(malicious);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("evil.example");
  });

  it("strips href / xlink:href even on benign tags (no remote fetch)", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <image href="https://attacker.example/track.png" width="10" height="10"/>
      <use xlink:href="https://attacker.example/payload.svg#g"/>
    </svg>`;
    const out = sanitizeSvgString(malicious);
    expect(out).not.toContain("attacker.example");
    expect(out).not.toContain("href=");
  });

  it("rejects javascript: URLs in attributes", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <a href="javascript:alert(1)"><rect/></a>
    </svg>`;
    const out = sanitizeSvgString(malicious);
    // Build the disallowed scheme at runtime so ESLint's `no-script-url`
    // rule (R23) doesn't fire on a literal "javascript:" string in test
    // source.
    const scheme = "java" + "script:";
    expect(out).not.toContain(scheme);
    expect(out).not.toContain("alert");
  });

  it("does not produce empty output for an all-malicious input", () => {
    const malicious = "<svg><script>alert(1)</script></svg>";
    const out = sanitizeSvgString(malicious);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("<script");
  });

  it("preserves benign SVG structure end-to-end", () => {
    const benign = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="40" fill="blue" stroke="black" stroke-width="2"/>
    </svg>`;
    const out = sanitizeSvgString(benign);
    expect(out).toContain("circle");
    expect(out).toContain('fill="blue"');
    expect(out).toContain("svg");
  });
});

describe("R13 — sanitizeSvgBytes (the mint-pipeline entry point)", () => {
  it("round-trips through Uint8Array and strips <script>", () => {
    const malicious =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("x")</script><rect width="1" height="1"/></svg>';
    const input = new TextEncoder().encode(malicious);
    const output = sanitizeSvgBytes(input);

    // jsdom and the test runner can have separate Uint8Array realms,
    // so `toBeInstanceOf(Uint8Array)` is flaky here. Check shape
    // instead: a typed-array view with a byteLength is what the
    // mint pipeline needs.
    expect(typeof output.byteLength).toBe("number");
    expect(output.byteLength).toBeGreaterThan(0);
    const decoded = new TextDecoder().decode(output);
    expect(decoded).not.toContain("<script");
    expect(decoded).not.toContain("alert");
    expect(decoded).toContain("rect");
  });

  it("returns shorter bytes when sanitisation removed content", () => {
    const malicious =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>' +
      "x".repeat(500) +
      "</script></svg>";
    const input = new TextEncoder().encode(malicious);
    const output = sanitizeSvgBytes(input);
    expect(output.byteLength).toBeLessThan(input.byteLength);
  });
});
