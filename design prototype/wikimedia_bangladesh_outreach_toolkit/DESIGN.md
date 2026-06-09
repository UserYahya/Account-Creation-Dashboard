---
name: Wikimedia Bangladesh Outreach Toolkit
colors:
  surface: '#f8f9fa'
  surface-dim: '#d9dadb'
  surface-bright: '#f8f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f5'
  surface-container: '#edeeef'
  surface-container-high: '#e7e8e9'
  surface-container-highest: '#e1e3e4'
  on-surface: '#191c1d'
  on-surface-variant: '#414753'
  inverse-surface: '#2e3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#727784'
  outline-variant: '#c1c6d5'
  surface-tint: '#005cba'
  primary: '#004e9f'
  on-primary: '#ffffff'
  primary-container: '#0066cc'
  on-primary-container: '#dfe8ff'
  inverse-primary: '#aac7ff'
  secondary: '#006d42'
  on-secondary: '#ffffff'
  secondary-container: '#93f7bc'
  on-secondary-container: '#007346'
  tertiary: '#a30716'
  on-tertiary: '#ffffff'
  tertiary-container: '#c6292b'
  on-tertiary-container: '#ffe1de'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d7e3ff'
  primary-fixed-dim: '#aac7ff'
  on-primary-fixed: '#001b3e'
  on-primary-fixed-variant: '#00458e'
  secondary-fixed: '#93f7bc'
  secondary-fixed-dim: '#77daa1'
  on-secondary-fixed: '#002111'
  on-secondary-fixed-variant: '#005231'
  tertiary-fixed: '#ffdad6'
  tertiary-fixed-dim: '#ffb3ad'
  on-tertiary-fixed: '#410003'
  on-tertiary-fixed-variant: '#930011'
  background: '#f8f9fa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e4'
typography:
  display-lg:
    fontFamily: Noto Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
  headline-md:
    fontFamily: Noto Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-sm:
    fontFamily: Noto Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Noto Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Noto Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Noto Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  headline-lg-mobile:
    fontFamily: Noto Sans
    fontSize: 26px
    fontWeight: '700'
    lineHeight: 32px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  container-max: 1120px
  gutter: 16px
---

## Brand & Style

The design system is rooted in the values of the global Wikimedia movement: openness, reliability, and neutrality. It is designed specifically for an outreach tool managed by Wikimedia Bangladesh, targeting educators, students, and volunteers. 

The visual style is **Corporate / Modern** with a strong emphasis on **Information Hierarchy**. It avoids unnecessary flourishes to focus on utility and accessibility. The aesthetic mirrors the "Minerva" and "Vector" design languages of Wikipedia—prioritizing content over container. The emotional response should be one of institutional trust and ease of use, ensuring that users feel they are in an official, safe, and collaborative environment.

## Colors

This design system utilizes a palette that is instantly recognizable to the Wikimedia community. 

- **Primary (#0066CC):** Used for primary action buttons, active states, and hyperlinks. This color represents progress and interaction.
- **Secondary / Success (#339966):** Used for positive confirmations, "Save" actions, and indicating completed outreach milestones.
- **Tertiary / Error (#D33333):** Used for destructive actions (Delete/Cancel) and error validation messages.
- **Neutral / Surface:** The background remains `#FFFFFF` (White) to maximize contrast. `#F8F9FA` is used for subtle section headers and table backgrounds to provide structure without clutter.
- **Text:** Primary body text uses `#202122` (near-black) for optimal legibility, while metadata and labels use `#54595D` (slate gray).

## Typography

Typography is the cornerstone of this design system. We use **Noto Sans** (with Noto Sans Bengali for local script) to ensure a high level of legibility across all devices. 

- **Language Support:** All styles are optimized for Bengali script, ensuring that line heights are generous enough to accommodate conjunct characters without clipping.
- **Hierarchy:** We use a strict typographic scale. Headers are bold and dark to provide clear entry points into content. Body text is sized for long-form reading, essential for an educational outreach tool.
- **Links:** All links should be underlined on hover to maintain the "web classic" accessibility standard of Wikipedia.

## Layout & Spacing

The layout follows a **Fixed Grid** philosophy on desktop to maintain readability and a **Fluid Grid** on mobile devices.

- **Desktop:** Content is centered within a 1120px container. This prevents line lengths from becoming too long for comfortable reading.
- **Grid:** A 12-column system is used for dashboard views and data-heavy pages.
- **Spacing Rhythm:** We use a base-4 system. Padding and margins should always be multiples of 4px. 
- **Responsive Behavior:** 
  - **Mobile (<768px):** Margins reduce to 16px. Multi-column cards stack vertically.
  - **Tablet (768px - 1024px):** 24px margins. Use 2-column layouts for forms and cards.

## Elevation & Depth

This design system uses **Low-contrast outlines** and **Tonal layers** rather than heavy shadows. 

- **Surface 0:** The main application background (#FFFFFF).
- **Surface 1:** Light gray backgrounds (#F8F9FA) for sidebar navigation or secondary info boxes.
- **Borders:** A 1px solid border (#C8CCD1) is the primary method for defining card boundaries and input fields.
- **Shadows:** Only used on active modal overlays or dropdown menus to signify temporary depth. Use a soft, neutral shadow: `0 2px 4px rgba(0,0,0,0.1)`.

## Shapes

In keeping with a professional and functional aesthetic, the design system utilizes **Soft** roundedness. 

- **Buttons & Inputs:** 0.25rem (4px) corner radius. This provides a modern feel while remaining structured and serious.
- **Cards & Modals:** 0.5rem (8px) corner radius for larger containers to differentiate them from smaller interactive elements.
- **Icons:** Use sharp or slightly rounded SVG icons (like the OOUI icon set) to maintain consistency with Wikimedia’s interface standards.

## Components

### Buttons
- **Primary:** Background #0066CC, text #FFFFFF. High emphasis.
- **Secondary:** Background #F8F9FA, border #A2A9B1, text #202122. Low emphasis.
- **Quiet:** No background or border. Text #0066CC. Used for secondary actions in footers or lists.

### Input Fields
- Standard fields use a 1px border (#A2A9B1). On focus, the border thickens to 2px and changes to #0066CC.
- Help text and error messages should appear immediately below the input in Noto Sans (Bengali).

### Cards
- Used for summarizing outreach projects or volunteer statistics. Cards should have a 1px border (#C8CCD1) and no shadow. Title should be in `headline-sm`.

### Progress Indicators
- For tracking outreach goals (e.g., "Articles Created"), use a horizontal progress bar in Wikimedia Green (#339966) with a light gray track.

### Tables
- Essential for managing lists of students or articles. Use a simple horizontal line separator style. The header row should have a light gray background (#F8F9FA).