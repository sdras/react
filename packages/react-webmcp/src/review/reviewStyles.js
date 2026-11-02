/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// The overlay's stylesheet, injected once by <ToolReview>. Every class is
// prefixed with `rwr-` so nothing leaks into or out of the host app. The look
// follows the "Tool Review Modal" design (Option A): IBM Plex when the app has
// it, a light surface with a 12px modal, 44px rows and 6px controls.

export const REVIEW_CSS: string = `
.rwr-Root {
  --rwr-bg: #f3f4f6;
  --rwr-surface: #ffffff;
  --rwr-surface-2: #fafbfc;
  --rwr-ink: #1a1d23;
  --rwr-ink-2: #3b4250;
  --rwr-muted: #5c6470;
  --rwr-faint: #8a919c;
  --rwr-line: #e4e7ec;
  --rwr-line-2: #eef0f3;
  --rwr-control: #d5d9e0;
  --rwr-accent: #3b5bdb;
  --rwr-accent-ink: #2f47b8;
  --rwr-accent-soft: #e9ecf9;
  --rwr-accent-row: #eef1fc;
  --rwr-ok: #15784a;
  --rwr-ok-bg: #e6f4ec;
  --rwr-warn: #b9770e;
  --rwr-warn-bg: #fff4e0;
  --rwr-warn-ink: #8a5a00;
  --rwr-bad: #b3261e;
  --rwr-bad-bg: #fdeaea;
  --rwr-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --rwr-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(26, 29, 35, 0.48);
  color: var(--rwr-ink);
  font-family: var(--rwr-sans);
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  text-align: left;
}
.rwr-Root *, .rwr-Root *::before, .rwr-Root *::after { box-sizing: border-box; }
/* Zero-specificity resets (:where) so every component rule below wins. */
.rwr-Root :where(button, input, select, textarea) {
  font: inherit;
  color: inherit;
  margin: 0;
}
.rwr-Root :where(button) { cursor: pointer; }
.rwr-Root :where(button:disabled) { cursor: default; opacity: 0.55; }
.rwr-Root :focus-visible { outline: 2px solid var(--rwr-accent); outline-offset: 1px; }
.rwr-Mono { font-family: var(--rwr-mono); }
.rwr-Spacer { flex: 1; }
.rwr-Icon { width: 16px; height: 16px; flex: none; display: inline-block; vertical-align: -3px; }
.rwr-Modal {
  width: min(1120px, 100%);
  height: min(784px, 100%);
  background: var(--rwr-surface);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(15, 18, 25, 0.28), 0 2px 8px rgba(15, 18, 25, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rwr-Header { display: flex; align-items: center; gap: 24px; padding: 18px 24px 16px; border-bottom: 1px solid var(--rwr-line); }
.rwr-HeaderText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rwr-Title { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.rwr-Subtitle { color: var(--rwr-muted); margin: 0; }
.rwr-Progress { display: flex; flex-direction: column; gap: 6px; width: 260px; margin-left: auto; flex: none; }
.rwr-ProgressLabel { font-size: 12px; color: var(--rwr-muted); display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
.rwr-ProgressBar { height: 6px; border-radius: 3px; background: #e6e8ed; overflow: hidden; }
.rwr-ProgressFill { height: 100%; background: var(--rwr-accent); border-radius: 3px; transition: width 160ms ease; }
.rwr-IconBtn { width: 32px; height: 32px; border-radius: 6px; border: none; background: transparent; color: var(--rwr-muted); display: inline-flex; align-items: center; justify-content: center; padding: 0; flex: none; }
.rwr-IconBtn:hover { background: var(--rwr-line-2); color: var(--rwr-ink); }
.rwr-Toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 24px; border-bottom: 1px solid var(--rwr-line); background: var(--rwr-surface-2); flex-wrap: wrap; }
.rwr-Search { flex: 0 1 320px; min-width: 180px; height: 34px; border: 1px solid var(--rwr-control); border-radius: 6px; background: var(--rwr-surface); display: flex; align-items: center; gap: 8px; padding: 0 10px; color: var(--rwr-faint); }
.rwr-Search:focus-within { border-color: var(--rwr-accent); box-shadow: 0 0 0 3px rgba(59, 91, 219, 0.15); }
.rwr-SearchInput { flex: 1; min-width: 0; border: none; background: transparent; outline: none; color: var(--rwr-ink); padding: 0; height: 100%; }
.rwr-SearchInput::placeholder { color: var(--rwr-faint); }
.rwr-Kbd { font-family: var(--rwr-mono); font-size: 11px; color: var(--rwr-muted); border: 1px solid var(--rwr-control); border-radius: 4px; padding: 0 5px; line-height: 18px; background: var(--rwr-surface); display: inline-block; }
.rwr-Chips { display: flex; gap: 6px; flex-wrap: wrap; }
.rwr-Chip { height: 28px; padding: 0 10px; border-radius: 14px; border: 1px solid var(--rwr-control); display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--rwr-ink-2); background: var(--rwr-surface); white-space: nowrap; }
.rwr-Chip:hover { border-color: var(--rwr-faint); }
.rwr-ChipCount { color: var(--rwr-faint); font-variant-numeric: tabular-nums; }
.rwr-ChipOn, .rwr-ChipOn:hover { background: var(--rwr-ink); border-color: var(--rwr-ink); color: #ffffff; }
.rwr-ChipOn .rwr-ChipCount { color: rgba(255, 255, 255, 0.7); }
.rwr-Select { display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 8px; border-radius: 6px; color: var(--rwr-muted); font-size: 12.5px; white-space: nowrap; }
.rwr-Select select { border: none; background: transparent; font-weight: 600; color: var(--rwr-ink); padding: 0 2px; cursor: pointer; }
.rwr-Body { flex: 1; display: flex; min-height: 0; }
.rwr-List { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.rwr-ListHead, .rwr-Row { display: grid; grid-template-columns: minmax(0, 1fr) 112px 128px; align-items: center; column-gap: 12px; padding: 0 20px; }
.rwr-ListHead { height: 34px; border-bottom: 1px solid var(--rwr-line); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--rwr-faint); flex: none; }
.rwr-Rows { flex: 1; overflow: auto; }
.rwr-GroupHead { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 20px; background: var(--rwr-surface-2); border-bottom: 1px solid var(--rwr-line); position: sticky; top: 0; }
.rwr-GroupName { font-family: var(--rwr-mono); font-weight: 600; font-size: 12.5px; }
.rwr-GroupMeta { color: var(--rwr-faint); font-size: 12px; }
.rwr-GroupAction { margin-left: auto; color: var(--rwr-accent); font-weight: 500; font-size: 12.5px; border: none; background: transparent; padding: 4px 6px; border-radius: 4px; }
.rwr-GroupAction:hover { background: var(--rwr-accent-soft); }
.rwr-Row { width: 100%; height: 44px; border: none; border-bottom: 1px solid var(--rwr-line-2); background: var(--rwr-surface); text-align: left; }
.rwr-Row:hover { background: var(--rwr-surface-2); }
.rwr-RowOn, .rwr-RowOn:hover { background: var(--rwr-accent-row); box-shadow: inset 3px 0 0 var(--rwr-accent); }
.rwr-RowMain { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0; max-width: 100%; }
.rwr-RowName { font-family: var(--rwr-mono); font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.rwr-RowDesc { color: var(--rwr-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; max-width: 100%; }
.rwr-Tag { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 4px; font-size: 11.5px; font-weight: 500; white-space: nowrap; width: max-content; }
.rwr-Tag-read { background: var(--rwr-line-2); color: var(--rwr-ink-2); }
.rwr-Tag-mutate { background: var(--rwr-warn-bg); color: var(--rwr-warn-ink); }
.rwr-Tag-irreversible { background: var(--rwr-bad-bg); color: var(--rwr-bad); }
.rwr-Tag-proposed { background: var(--rwr-accent-soft); color: var(--rwr-accent-ink); }
.rwr-Tag-accepted { background: var(--rwr-ok-bg); color: var(--rwr-ok); }
.rwr-Tag-rejected { background: var(--rwr-line-2); color: var(--rwr-muted); text-decoration: line-through; }
.rwr-Tag-exported { background: var(--rwr-line-2); color: var(--rwr-ink-2); }
.rwr-Tag-ungrounded { background: var(--rwr-bad-bg); color: var(--rwr-bad); }
.rwr-Status { display: inline-flex; align-items: center; gap: 6px; }
.rwr-ok { color: var(--rwr-ok); } .rwr-warn { color: var(--rwr-warn); } .rwr-bad { color: var(--rwr-bad); } .rwr-pending { color: var(--rwr-faint); }
.rwr-ListFoot { height: 36px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-top: 1px solid var(--rwr-line); color: var(--rwr-faint); font-size: 12px; background: var(--rwr-surface-2); flex: none; }
.rwr-Kbds { display: inline-flex; align-items: center; gap: 4px; }
.rwr-Empty { padding: 40px 20px; color: var(--rwr-muted); text-align: center; }
.rwr-Form { flex: 0 0 400px; border-left: 1px solid var(--rwr-line); display: flex; flex-direction: column; min-height: 0; }
.rwr-FormScroll { flex: 1; overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.rwr-FormHead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rwr-FormName { font-family: var(--rwr-mono); font-size: 15px; font-weight: 600; word-break: break-all; }
.rwr-FormNav { margin-left: auto; color: var(--rwr-faint); font-size: 12px; white-space: nowrap; }
.rwr-Evidence { border: 1px solid var(--rwr-line); border-radius: 8px; background: var(--rwr-surface-2); padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }
.rwr-EvidenceHead { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12.5px; }
.rwr-EvidenceMeta { margin-left: auto; color: var(--rwr-faint); font-weight: 400; font-size: 11.5px; }
.rwr-EvRow { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--rwr-ink-2); }
.rwr-EvRow .rwr-Icon { width: 14px; height: 14px; margin-top: 2px; }
.rwr-EvRow .rwr-Mono { font-size: 12px; }
.rwr-EvLink { color: var(--rwr-accent); font-family: var(--rwr-mono); font-size: 12px; border: none; background: transparent; padding: 0; text-decoration: underline; text-underline-offset: 2px; }
.rwr-Field { display: flex; flex-direction: column; gap: 6px; }
.rwr-Label { font-size: 12px; font-weight: 500; color: var(--rwr-ink-2); }
.rwr-Input, .rwr-Textarea { width: 100%; border: 1px solid var(--rwr-control); border-radius: 6px; background: var(--rwr-surface); font-size: 12.5px; }
.rwr-Input { height: 34px; padding: 0 10px; }
.rwr-Textarea { min-height: 58px; padding: 8px 10px; line-height: 1.5; resize: vertical; }
.rwr-Input:focus, .rwr-Textarea:focus { outline: none; border-color: var(--rwr-accent); box-shadow: 0 0 0 3px rgba(59, 91, 219, 0.15); }
.rwr-Hint { font-size: 11.5px; color: var(--rwr-faint); white-space: nowrap; }
.rwr-Two { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 12px; align-items: start; }
.rwr-Segmented { display: flex; border: 1px solid var(--rwr-control); border-radius: 6px; overflow: hidden; height: 32px; background: var(--rwr-surface); }
.rwr-Seg { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--rwr-ink-2); border: none; border-right: 1px solid var(--rwr-line); background: transparent; padding: 0 5px; white-space: nowrap; }
.rwr-Seg:last-child { border-right: none; }
.rwr-SegOn { background: var(--rwr-ink); color: #ffffff; font-weight: 500; }
.rwr-SchemaHead { display: flex; align-items: center; justify-content: space-between; }
.rwr-Add { color: var(--rwr-accent); font-weight: 500; font-size: 12.5px; display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; padding: 2px 4px; border-radius: 4px; }
.rwr-Add:hover { background: var(--rwr-accent-soft); }
.rwr-Add .rwr-Icon { width: 14px; height: 14px; }
.rwr-Props { border: 1px solid var(--rwr-line); border-radius: 6px; overflow: hidden; }
.rwr-Prop { display: grid; grid-template-columns: minmax(70px, 0.9fr) 72px 24px minmax(0, 1.4fr) auto; column-gap: 8px; align-items: center; min-height: 34px; padding: 4px 8px; border-bottom: 1px solid var(--rwr-line-2); font-size: 12.5px; }
.rwr-Prop:last-child { border-bottom: none; }
.rwr-PropInput { width: 100%; min-width: 0; height: 26px; border: 1px solid transparent; border-radius: 4px; background: transparent; padding: 0 4px; font-size: 12px; }
.rwr-PropInput:hover { border-color: var(--rwr-line); }
.rwr-PropInput:focus { outline: none; border-color: var(--rwr-accent); background: var(--rwr-surface); }
.rwr-PropName { font-family: var(--rwr-mono); font-weight: 500; }
.rwr-PropType { color: var(--rwr-muted); font-family: var(--rwr-mono); }
.rwr-PropReq { justify-self: center; accent-color: var(--rwr-accent); margin: 0; }
.rwr-PropDesc { color: var(--rwr-muted); }
.rwr-PropFlag { color: var(--rwr-warn); font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.rwr-PropFlag .rwr-Icon { width: 13px; height: 13px; }
.rwr-PropRemove { border: none; background: transparent; color: var(--rwr-faint); padding: 2px; border-radius: 4px; line-height: 0; }
.rwr-PropRemove:hover { color: var(--rwr-bad); background: var(--rwr-bad-bg); }
.rwr-PropEmpty { padding: 10px; color: var(--rwr-faint); font-size: 12px; }
.rwr-FormFoot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 20px; border-top: 1px solid var(--rwr-line); background: var(--rwr-surface); flex-wrap: wrap; }
.rwr-Btn { height: 34px; padding: 0 14px; border-radius: 6px; border: 1px solid var(--rwr-control); background: var(--rwr-surface); color: var(--rwr-ink); font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.rwr-Btn:hover { border-color: var(--rwr-faint); }
.rwr-Btn .rwr-Icon { width: 15px; height: 15px; }
.rwr-Primary, .rwr-Primary:hover { background: var(--rwr-accent); border-color: var(--rwr-accent); color: #ffffff; }
.rwr-Primary:hover { background: var(--rwr-accent-ink); }
.rwr-Ghost { border-color: transparent; background: transparent; color: var(--rwr-ink-2); padding: 0 8px; }
.rwr-Foot { display: flex; align-items: center; gap: 8px; padding: 12px 24px; border-top: 1px solid var(--rwr-line); background: var(--rwr-surface); flex-wrap: wrap; }
.rwr-FootNote { color: var(--rwr-faint); font-size: 12px; margin-right: 8px; }
.rwr-Note { font-size: 12.5px; color: var(--rwr-muted); border: 1px dashed var(--rwr-control); border-radius: 6px; padding: 10px 12px; }
.rwr-ReadOnly { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 6px 12px; font-size: 12.5px; }
.rwr-ReadOnly dt { color: var(--rwr-faint); margin: 0; }
.rwr-ReadOnly dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.rwr-Pre { font-family: var(--rwr-mono); font-size: 11.5px; background: var(--rwr-surface-2); border: 1px solid var(--rwr-line); border-radius: 6px; padding: 8px 10px; margin: 0; overflow: auto; max-height: 180px; }
@media (max-width: 900px) {
  .rwr-Root { padding: 8px; }
  .rwr-Header { gap: 12px; padding: 14px 16px 12px; flex-wrap: wrap; }
  .rwr-Progress { width: 100%; margin-left: 0; order: 3; }
  .rwr-Toolbar, .rwr-ListHead, .rwr-Row, .rwr-GroupHead, .rwr-ListFoot, .rwr-Foot { padding-left: 16px; padding-right: 16px; }
  .rwr-Body { flex-direction: column; }
  .rwr-List { flex: 1 1 45%; }
  .rwr-Form { flex: 1 1 55%; border-left: none; border-top: 1px solid var(--rwr-line); }
  .rwr-ListHead, .rwr-Row { grid-template-columns: minmax(0, 1fr) 92px 112px; column-gap: 8px; }
  .rwr-Two { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .rwr-ProgressFill { transition: none; }
}
`;
