// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The anti-drift guard for `src/xliff-enums.ts`.
 *
 * `@lexi/shared` mirrors four of the engine's vocabularies instead of
 * re-exporting them, because the engine's barrel is not browser-safe. That
 * duplication is made safe here rather than by discipline:
 *
 *   - the `expectTypeOf` assertions fail at COMPILE time (`tsc -b`) if a union
 *     gains, loses or renames a member;
 *   - the `toEqual` assertions fail at RUN time if the values or their order
 *     drift, which the type check alone would not catch.
 *
 * This file lives in `test/`, outside the web app's path mapping, so the
 * `@lexi/xliff` import never enters the browser TypeScript program.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  DEFAULT_SEVERITIES as ENGINE_DEFAULT_SEVERITIES,
  FIX_KINDS as ENGINE_FIX_KINDS,
  LOCALE_SOURCES as ENGINE_LOCALE_SOURCES,
  RULE_IDS as ENGINE_RULE_IDS,
  UNIT_STATES as ENGINE_UNIT_STATES,
  WRITE_STATE_MODES as ENGINE_WRITE_STATE_MODES,
  type Finding as EngineFinding,
  type FixKind as EngineFixKind,
  type RuleId as EngineRuleId,
  type LocaleSource as EngineLocaleSource,
  type Severity as EngineSeverity,
  type UnitState as EngineUnitState,
  type WriteStateMode as EngineWriteStateMode,
} from '@lexi/xliff';

import {
  DEFAULT_SEVERITIES,
  FIX_KINDS,
  LOCALE_SOURCES,
  RULE_IDS,
  UNIT_STATES,
  WRITE_STATE_MODES,
  type Finding,
  type FixKind,
  type LocaleSource,
  type RuleId,
  type Severity,
  type UnitState,
  type WriteStateMode,
} from '../src/index.js';

describe('shared mirrors of @lexi/xliff', () => {
  it('UNIT_STATES matches the engine, in order', () => {
    expectTypeOf<UnitState>().toEqualTypeOf<EngineUnitState>();
    expect(UNIT_STATES).toEqual(ENGINE_UNIT_STATES);
  });

  it('WRITE_STATE_MODES matches the engine, in order', () => {
    expectTypeOf<WriteStateMode>().toEqualTypeOf<EngineWriteStateMode>();
    expect(WRITE_STATE_MODES).toEqual(ENGINE_WRITE_STATE_MODES);
  });

  it('RULE_IDS matches the engine, in order', () => {
    expectTypeOf<RuleId>().toEqualTypeOf<EngineRuleId>();
    expect(RULE_IDS).toEqual(ENGINE_RULE_IDS);
  });

  it('LOCALE_SOURCES matches the engine, in order', () => {
    expectTypeOf<LocaleSource>().toEqualTypeOf<EngineLocaleSource>();
    expect(LOCALE_SOURCES).toEqual(ENGINE_LOCALE_SOURCES);
  });

  it('Severity matches the engine', () => {
    expectTypeOf<Severity>().toEqualTypeOf<EngineSeverity>();
  });

  it('DEFAULT_SEVERITIES matches the engine, rule for rule', () => {
    expect(DEFAULT_SEVERITIES).toEqual(ENGINE_DEFAULT_SEVERITIES);
  });

  it('FIX_KINDS matches the engine, in order', () => {
    expectTypeOf<FixKind>().toEqualTypeOf<EngineFixKind>();
    expect(FIX_KINDS).toEqual(ENGINE_FIX_KINDS);
  });

  it('an engine Finding is assignable to the wire Finding', () => {
    // Deliberately one-directional: the engine's value must be sendable.
    // The wire type is the looser of the two, so the reverse need not hold.
    expectTypeOf<EngineFinding>().toExtend<Finding>();
  });
});
