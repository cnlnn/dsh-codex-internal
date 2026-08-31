# Fixture provenance

The tool-call payloads are sanitized reconstructions based on the observed errors at positions 3740 and 2978. They preserve the complete object shape and the malformed `arguments_json` tail ending at `,{`; they are not exact raw responses.

`codex-request-body-parse-failure-redacted.json` mirrors the observed DSH finish/turn sequence (turn 14, step 93, seq 6877/6879) with timestamps and identifiers omitted. It is a redacted shape fixture, not an exact raw event.
