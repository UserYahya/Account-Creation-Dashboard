/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        'on-secondary-fixed-variant': '#005231',
        'on-surface': '#191c1d',
        'on-error-container': '#93000a',
        'tertiary-container': '#c6292b',
        outline: '#727784',
        'surface-tint': '#005cba',
        'tertiary-fixed-dim': '#ffb3ad',
        'surface-dim': '#d9dadb',
        'on-secondary-container': '#007346',
        'on-primary-fixed': '#001b3e',
        primary: '#004e9f',
        background: '#f8f9fa',
        'on-error': '#ffffff',
        tertiary: '#a30716',
        'on-tertiary-fixed-variant': '#930011',
        'on-surface-variant': '#414753',
        'on-background': '#191c1d',
        'on-secondary-fixed': '#002111',
        'surface-variant': '#e1e3e4',
        'primary-fixed-dim': '#aac7ff',
        'on-tertiary-container': '#ffe1de',
        'secondary-fixed': '#93f7bc',
        'error-container': '#ffdad6',
        'surface-container-low': '#f3f4f5',
        'on-primary-container': '#dfe8ff',
        'secondary-fixed-dim': '#77daa1',
        'on-primary-fixed-variant': '#00458e',
        'surface-container-lowest': '#ffffff',
        'surface-container-highest': '#e1e3e4',
        'on-primary': '#ffffff',
        surface: '#f8f9fa',
        'inverse-surface': '#2e3132',
        'secondary-container': '#93f7bc',
        'primary-container': '#0066cc',
        secondary: '#006d42',
        'inverse-on-surface': '#f0f1f2',
        'on-secondary': '#ffffff',
        'inverse-primary': '#aac7ff',
        error: '#ba1a1a',
        'outline-variant': '#c1c6d5',
        'on-tertiary-fixed': '#410003',
        'surface-bright': '#f8f9fa',
        'primary-fixed': '#d7e3ff',
        'tertiary-fixed': '#ffdad6',
        'surface-container': '#edeeef',
        'surface-container-high': '#e7e8e9',
        'on-tertiary': '#ffffff'
      },
      borderRadius: {
        DEFAULT: '0.125rem',
        lg: '0.25rem',
        xl: '0.5rem',
        full: '0.75rem',
        pill: '9999px'
      },
      spacing: {
        lg: '24px',
        sm: '8px',
        xl: '40px',
        xs: '4px',
        md: '16px',
        'container-max': '1120px',
        gutter: '16px',
        unit: '4px'
      },
      maxWidth: {
        'container-max': '1120px'
      },
      fontFamily: {
        sans: ['Inter', 'Hind Siliguri', 'sans-serif']
      },
      fontSize: {
        'body-md': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'label-md': ['12px', { lineHeight: '16px', letterSpacing: '0.02em', fontWeight: '500' }],
        'body-lg': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'display-lg': ['32px', { lineHeight: '40px', fontWeight: '700' }],
        'headline-md': ['24px', { lineHeight: '32px', fontWeight: '600' }],
        'headline-sm': ['20px', { lineHeight: '28px', fontWeight: '600' }]
      }
    }
  },
  plugins: [require('@tailwindcss/forms')]
};
