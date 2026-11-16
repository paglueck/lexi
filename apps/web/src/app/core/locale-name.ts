// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
const names = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * "pt-BR" → "Portuguese (BR)", the README's short form; the tag when Intl has
 * no name. Shared by the Term Base columns and the jobs screens' locale rows.
 */
export function localeName(code: string): string {
  const [language, region] = code.split('-');
  let name: string;
  try {
    name = names.of(language ?? code) ?? code;
  } catch {
    return code;
  }
  return region === undefined ? name : `${name} (${region})`;
}
