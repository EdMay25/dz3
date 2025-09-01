module.exports = {
  extends: ['html-validate:recommended'],
  rules: {
    'element-required-attributes': 'error',
    'no-inline-style': 'error',
    'close-order': 'error',
    'attr-quotes': 'error',
    'void-style': 'error',
    'no-implicit-close': 'error',
    'prefer-tbody': 'error',
    'no-raw-characters': 'error'
  },
  ignores: [
    '**/node_modules/**/*.html'
  ]
};
