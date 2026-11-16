// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import {
  withXliffTargetLanguage,
  xliffSide,
  xliffUploadOptions,
} from '../src/lib/xliff-language.js';

/** The uploaded copy of an XLIFF names the Phrase locale; nothing else changes. */
describe('withXliffTargetLanguage', () => {
  it('replaces target-language on every <file> of XLIFF 1.2', () => {
    const text =
      '<xliff version="1.2"><file source-language="en-GB" target-language=\'de\' datatype="x">' +
      '<body/></file><file target-language="de"/></xliff>';
    expect(withXliffTargetLanguage(text, 'Developer-German')).toBe(
      '<xliff version="1.2"><file source-language="en-GB" target-language="Developer-German" datatype="x">' +
        '<body/></file><file target-language="Developer-German"/></xliff>',
    );
  });

  it('adds target-language where the file has none, and escapes the value', () => {
    expect(withXliffTargetLanguage('<file source-language="en">', 'A & "B" $1')).toBe(
      '<file source-language="en" target-language="A &amp; &quot;B&quot; $1">',
    );
  });

  it('sets trgLang on the root of XLIFF 2', () => {
    expect(
      withXliffTargetLanguage('<xliff version="2.0" srcLang="en" trgLang="de"><file id="f">', 'X'),
    ).toBe('<xliff version="2.0" srcLang="en" trgLang="X"><file id="f">');
  });

  it('leaves source-language alone', () => {
    expect(withXliffTargetLanguage('<file source-language="de">', 'X')).toBe(
      '<file source-language="de" target-language="X">',
    );
  });
});

describe('xliffSide', () => {
  it('reads the template as its source side, a translation as its target side', () => {
    expect(xliffSide('<file source-language="en-GB" target-language="en-GB">')).toBe('source');
    expect(xliffSide('<file source-language="en-GB">')).toBe('source');
    expect(xliffSide("<file source-language='en-GB' target-language='de'>")).toBe('target');
  });

  it('reads XLIFF 2 from the root', () => {
    expect(xliffSide('<xliff version="2.0" srcLang="en" trgLang="de"><file id="f">')).toBe(
      'target',
    );
    expect(xliffSide('<xliff version="2.0" srcLang="en"><file id="f">')).toBe('source');
  });

  it('ignores exactly the side that is not pushed', () => {
    expect(xliffUploadOptions('target')).toEqual({
      override_file_language: true,
      ignore_source_translations: true,
      ignore_target_translations: false,
    });
    expect(xliffUploadOptions('source')).toMatchObject({
      ignore_source_translations: false,
      ignore_target_translations: true,
    });
  });
});
