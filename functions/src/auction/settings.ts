// ═══════════════════════════════════════════════════════════════════════════════
// AUCTION ENGINE — settings shape (domain-generic; NO Firebase, NO I/O).
//
// This file is part of the future extractable auction engine. Vocabulary is
// generic (bid/bidder/item/amount). Games PIN these settings to concrete values;
// the resolver branches on them. Every knob exists as a real parameter even when
// eBay only enables one value — so extraction is a `git mv`, not a rewrite.
// ═══════════════════════════════════════════════════════════════════════════════

export interface AuctionSettings {
  // ── INSTRUCTOR-EDITABLE (Settings page; per-instance override) ──
  durationSeconds: number;   // eBay default 600
  increment: number;         // eBay default 1

  // ── COMPILED DEFAULTS (parameters exist; other values may be unimplemented) ──
  direction: 'ascending' | 'descending';   // eBay: 'ascending'
  format: 'open' | 'sealed';               // eBay: 'open'
  closeType: 'hard' | 'soft';              // eBay: 'hard'  (not the resolver's concern)
  pricing: 'first' | 'second';             // eBay: 'second'
  proxyBidding: boolean;                   // eBay: true
  revealAtClose: 'full' | 'none';          // eBay: 'full'
}
