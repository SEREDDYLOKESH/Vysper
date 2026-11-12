const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== Verifying Universal Single-Column Full-Width Layout Across All Skills ===\n');

// 1. Verify llm-response.html
const llmResponseHtml = fs.readFileSync(path.join(__dirname, '..', 'llm-response.html'), 'utf-8');

// Check that grid-template-columns: 1fr 1fr is removed
assert(
  !llmResponseHtml.includes('grid-template-columns: 1fr 1fr;'),
  'llm-response.html still contains grid-template-columns: 1fr 1fr'
);
console.log('✓ Grid split (1fr 1fr) removed from llm-response.html');

// Check that Universal Single-Column CSS rules are present in llm-response.html
assert(
  llmResponseHtml.includes('.response-container') &&
  llmResponseHtml.includes('.dsa-layout') &&
  llmResponseHtml.includes('.programming-layout') &&
  llmResponseHtml.includes('.split-layout') &&
  llmResponseHtml.includes('display: flex !important;') &&
  llmResponseHtml.includes('flex-direction: column !important;') &&
  llmResponseHtml.includes('grid-template-columns: none !important;'),
  'llm-response.html missing universal single-column container CSS overrides'
);
console.log('✓ Universal Single-Column Container CSS rules verified in llm-response.html');

// Check 100% width code blocks in llm-response.html
assert(
  llmResponseHtml.includes('.code-container') &&
  llmResponseHtml.includes('.code-block') &&
  llmResponseHtml.includes('.full-content-inner') &&
  llmResponseHtml.includes('width: 100% !important;'),
  'llm-response.html missing 100% width overrides for code containers'
);
console.log('✓ 100% width for code blocks & containers verified in llm-response.html');

// Check that displayResponse always delegates to displayFullLayout
assert(
  llmResponseHtml.includes('displayFullLayout(response);') &&
  !llmResponseHtml.includes('if (hasCode) {\n                // Split layout'),
  'llm-response.html still conditionally routes to split layout'
);
console.log('✓ displayResponse always routes to displayFullLayout in llm-response.html');

// 2. Verify src/ui/llm-response-window.js
const llmResponseWindowJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'llm-response-window.js'), 'utf-8');

assert(
  llmResponseWindowJs.includes('this.currentLayout = "full";'),
  'llm-response-window.js currentLayout should be full'
);
assert(
  llmResponseWindowJs.includes('this.displayFullLayout(response);'),
  'llm-response-window.js missing displayFullLayout invocation'
);
assert(
  !llmResponseWindowJs.includes('this.displaySplitLayout(response, codeBlocks);'),
  'llm-response-window.js still calls displaySplitLayout'
);
console.log('✓ src/ui/llm-response-window.js always renders full single-column layout');

// 3. Verify src/styles/common.css
const commonCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles', 'common.css'), 'utf-8');
assert(
  commonCss.includes('.response-container') &&
  commonCss.includes('.dsa-layout') &&
  commonCss.includes('.programming-layout') &&
  commonCss.includes('.split-layout') &&
  commonCss.includes('display: flex !important;') &&
  commonCss.includes('grid-template-columns: none !important;'),
  'src/styles/common.css missing universal single-column rules'
);
console.log('✓ src/styles/common.css universal single-column rules verified');

// 4. Verify src/input.css
const inputCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.css'), 'utf-8');
assert(
  inputCss.includes('.response-container') &&
  inputCss.includes('.dsa-layout') &&
  inputCss.includes('.programming-layout') &&
  inputCss.includes('grid-template-columns: none !important;'),
  'src/input.css missing universal single-column rules'
);
console.log('✓ src/input.css universal single-column rules verified');

// 5. Verify src/styles/input.css
const stylesInputCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles', 'input.css'), 'utf-8');
assert(
  stylesInputCss.includes('.response-container') &&
  stylesInputCss.includes('.dsa-layout') &&
  stylesInputCss.includes('.programming-layout') &&
  stylesInputCss.includes('grid-template-columns: none !important;'),
  'src/styles/input.css missing universal single-column rules'
);
console.log('✓ src/styles/input.css universal single-column rules verified');

console.log('\n=== All Universal Single-Column Full-Width Layout Tests Passed! ===');
