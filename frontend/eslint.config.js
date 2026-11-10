import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': hooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-syntax': ['error', { selector: "MemberExpression[property.name='innerHTML']", message: 'innerHTML is forbidden (XSS); render text via React.' }],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
);
