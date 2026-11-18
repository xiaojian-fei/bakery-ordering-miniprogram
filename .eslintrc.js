/*
 * 代码风格参考配置（仓库不依赖 eslint，装了 ESLint 才会生效）。
 * core/ shared/ server/ scripts/ test/ 为 Node 环境，web/ 为浏览器 ES 模块环境。
 */
module.exports = {
  root: true,
  env: { es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
  extends: [],
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-undef': 'error',
    eqeqeq: ['error', 'smart'],
    'prefer-const': 'warn'
  },
  overrides: [
    {
      files: ['core/**/*.js', 'shared/**/*.js', 'server/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
      env: { node: true, browser: false },
      parserOptions: { sourceType: 'script' }
    },
    {
      files: ['web/**/*.js'],
      env: { browser: true, node: false },
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 }
    }
  ]
};
