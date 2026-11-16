// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The XLIFF engine.
 *
 * Pure except for `save.ts`, which is the only module that touches the
 * filesystem. Everything else is a function of its inputs, which is what keeps
 * the fidelity guarantees testable.
 *
 * The one idea the whole package rests on: the original file text is the truth,
 * and writing means splicing new substrings into it. Nothing that was not
 * deliberately changed is ever regenerated, so `escape(decode(x)) !== x` cannot
 * cost us anything, and a document with no edits serializes back to itself by
 * construction rather than by test.
 */

export type { CharOffset, Span } from './model.js';
export { sliceSpan, spanLength, isEmptySpan } from './model.js';

export { applyEdits, type Edit } from './splice.js';
export { escapeText, ESCAPE_POLICIES, type EscapePolicy } from './escape.js';
export { parseAttrSpans, type AttrSpan, type AttrSpans } from './attrspans.js';

export {
  scan,
  XlfScanError,
  type ElementRef,
  type TransUnit,
  type XlfContextGroup,
  type XlfDocument,
  type XlfFile,
  type XlfNote,
} from './scan.js';

export {
  segmentsOf,
  segmentsOfFragment,
  composeSegments,
  editedText,
  placeholderIds,
  plainText,
  textOnly,
  type GroupSegment,
  type PlaceholderSegment,
  type Segment,
  type TextSegment,
} from './segments.js';

export {
  serialize,
  writeTarget,
  writeTargetState,
  setFileAttr,
  deleteUnit,
  writeNotes,
  newNotePriority,
  type NoteSpec,
  insertUnit,
  insertionAnchor,
  sourceUnitXml,
  type SourceUnitSpec,
  unitSkeleton,
  localeFileSkeleton,
  type WriteTargetOptions,
} from './edits.js';

export { createXliffDocument, type CreateDocumentSpec, type CreateUnitSpec } from './create.js';

export {
  loadDocument,
  saveDocument,
  assertNotStale,
  atomicWrite,
  StaleFileError,
  type AtomicWriteOptions,
  type LoadedDocument,
  type SaveResult,
} from './save.js';

export {
  LOCALE_SOURCES,
  detectLocale,
  fileGroupOf,
  isTemplateFile,
  looksLikeLocaleDir,
  looksLikeLocaleTag,
  stripLocaleToken,
  type LocaleDetection,
  type LocaleSource,
  type StrippedName,
} from './locate.js';

export {
  readUnitState,
  xliffStateFor,
  shouldWriteState,
  hasTargetContent,
  UNIT_STATES,
  WRITE_STATE_MODES,
  type UnitState,
  type WriteStateMode,
} from './state.js';

export {
  maskSegments,
  unmask,
  restoreRaw,
  type MaskResult,
  type MaskToken,
  type UnmaskResult,
  type UnmaskFailureReason,
} from './mask.js';

export {
  flattenForIcu,
  unflattenIcu,
  parseIcu,
  looksLikeIcu,
  selectArguments,
  selectorsOf,
  type IcuBranch,
  type IcuFlat,
  type IcuNode,
  type IcuParseResult,
  type SelectNode,
  type SelectType,
} from './icu/parse.js';

export {
  pluralCategoriesFor,
  missingPluralCategories,
  deadPluralCategories,
  assertFullIcu,
  CLDR_CATEGORIES,
  type CldrCategory,
  type PluralType,
} from './icu/plurals.js';

export { verifyComposable, probeFragment } from './verify.js';

export {
  appearsIn,
  containsLoosely,
  usableTranslation,
  type GlossaryCheck,
} from './glossary-match.js';

export { wrongScript, scriptOf, scriptForLocale, SCRIPTS, type Script, type ScriptVerdict } from './script.js';

export {
  validateUnit,
  validateSegments,
  DEFAULT_SEVERITIES,
  RULE_IDS,
  type Finding,
  type FindingPlaceholders,
  type RuleId,
  type Severity,
  type ValidateContext,
} from './validate.js';

export { suggestFix, FIX_KINDS, type Fix, type FixKind } from './fixes.js';
