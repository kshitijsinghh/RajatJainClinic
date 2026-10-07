// Shared style helpers for touch-friendly, phone-first layout
// (see README "Responsive behavior": ≥44px touch targets, fluid grids).

export const TOUCH_BTN = {
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

// Two columns on wide screens, one column on phones.
export const FLUID_GRID_2COL = 'repeat(auto-fit, minmax(220px, 1fr))';
