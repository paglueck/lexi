// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject, signal } from '@angular/core';
import { UNIT_STATES } from '@lexi/shared/constants';
import type { UnitState } from '@lexi/shared';

import {
  GLYPH,
  ICON_NAMES,
  LxBadge,
  LxButton,
  LxCheckboxRow,
  LxCombobox,
  LxDropdown,
  LxField,
  LxHairlineGrid,
  LxIcon,
  LxInput,
  LxNavRow,
  LxPlaceholderChip,
  LxRadioCard,
  LxRadioCardGroup,
  LxSearchField,
  LxSegmentedControl,
  LxStackedBar,
  LxStateBadge,
  LxStepIndicator,
  LxModalService,
  LxToggle,
  type ButtonSize,
  type ButtonVariant,
} from '../../ui/index.js';
import { LxTitleBar } from '../../ui/chrome/title-bar.js';
import { LxToolbar } from '../../ui/chrome/toolbar.js';
import { KsSection } from './ks-section.js';
import { SEMANTIC_TOKENS } from './ks-tokens.js';
import { KsModalDemo } from './ks-modal-demo.js';

@Component({
  selector: 'lx-ks-content',
  imports: [
    KsSection,
    LxBadge,
    LxButton,
    LxIcon,
    LxCheckboxRow,
    LxCombobox,
    LxDropdown,
    LxField,
    LxHairlineGrid,
    LxInput,
    LxNavRow,
    LxPlaceholderChip,
    LxRadioCard,
    LxRadioCardGroup,
    LxSearchField,
    LxSegmentedControl,
    LxStackedBar,
    LxStateBadge,
    LxStepIndicator,
    LxTitleBar,
    LxToggle,
    LxToolbar,
  ],
  templateUrl: './ks-content.html',
  styleUrl: './ks-content.css',
})
export class KsContent {
  readonly #modals = inject(LxModalService);

  protected readonly tokenNames = SEMANTIC_TOKENS;

  /** Shadow and ring tokens are box-shadow values; as a background they read as blank. */
  protected isShadow(name: string): boolean {
    return name.includes('shadow') || name.includes('ring');
  }

  protected readonly states = UNIT_STATES;
  protected readonly glyphs = Object.entries(GLYPH.state).concat([
    ['error', GLYPH.error],
    ['info', GLYPH.info],
    ['retry', GLYPH.retry],
    ['caretDown', GLYPH.caretDown],
    ['caretRight', GLYPH.caretRight],
    ['close', GLYPH.close],
    ['cmd', GLYPH.cmd],
    ['enter', GLYPH.enter],
  ]);

  protected readonly variants: readonly ButtonVariant[] = [
    'primary',
    'secondary',
    'neutral',
    'accent-soft',
    'warn-soft',
    'danger-soft',
    'ghost',
  ];
  protected readonly iconNames = ICON_NAMES;
  protected readonly iconSizes: readonly ButtonSize[] = ['sm', 'field', 'xs'];
  protected readonly iconVariants: readonly ButtonVariant[] = [
    'ghost',
    'secondary',
    'neutral',
    'danger-soft',
  ];
  protected readonly sizes: readonly ButtonSize[] = ['hero', 'md', 'sm', 'field', 'xs'];

  protected readonly typeScale = [
    34, 28, 24, 20, 19, 17, 15, 14, 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10, 9.5, 9,
  ];

  protected readonly layout = signal<'grid' | 'focus'>('grid');
  protected readonly layoutOptions = [
    { value: 'grid' as const, label: 'Grid' },
    { value: 'focus' as const, label: 'Focus' },
  ];

  protected readonly toggleOn = signal(true);
  protected readonly toggleOff = signal(false);
  protected readonly filterA = signal(true);
  protected readonly filterB = signal(false);
  protected readonly locales = ['de', 'fr', 'pt-BR', 'pl', 'ar', 'es', 'it', 'ja', 'nl', 'tr'];
  protected readonly locale = signal('pt-BR');
  protected readonly search = signal('');

  /** Rows exactly as S4 lists them, so the review can compare like for like. */
  protected readonly rows: ReadonlyArray<{
    id: string;
    source: string;
    state: UnitState;
    error?: boolean;
  }> = [
    {
      id: '8f2c1a09b3e7',
      source: 'You have {{ invoiceCount }} invoices in this period',
      state: 'reviewed',
    },
    { id: 'checkout.pay_now', source: 'Pay now', state: 'final' },
    {
      id: 'checkout.free_ship',
      source: 'Free shipping over {{ threshold }}',
      state: 'draftMachine',
    },
    {
      id: 'd91f04ba77c1',
      source: '{count, plural, one {1 item} other {# items}}',
      state: 'needsReview',
      error: true,
    },
    { id: '2e9b4410cf07', source: 'Estimated delivery {{ date }}', state: 'untranslated' },
  ];

  protected readonly coverage = [
    { value: 83, tone: 'accent' as const, label: 'reviewed & final' },
    { value: 9, tone: 'warn' as const, label: 'machine draft' },
    { value: 5, tone: 'danger' as const, label: 'needs review' },
  ];

  protected openModal(): void {
    this.#modals.open(KsModalDemo);
  }
}
