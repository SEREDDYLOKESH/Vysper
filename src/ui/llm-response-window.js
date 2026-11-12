const logger = require("../core/logger");

class LLMResponseWindowUI {
  constructor() {
    this.currentLayout = "full";
    this.hasCode = false;
    this.currentSkill = "dsa";
    this.isInteractive = false;
    this.scrollableElements = [];

    this.elements = {};

    this.init();
    this.handleMouseEnter = this.handleMouseEnter.bind(this);
    this.handleMouseLeave = this.handleMouseLeave.bind(this);
    this.handleWheelScroll = this.handleWheelScroll.bind(this);
  }

  init() {
    try {
      this.setupElements();
      this.setupEventListeners();
      this.configureMarked();

      logger.info("LLM response window UI initialized", {
        component: "LLMResponseWindowUI",
      });
    } catch (error) {
      logger.error("Failed to initialize LLM response window UI", {
        component: "LLMResponseWindowUI",
        error: error.message,
      });
    }
  }

  setupElements() {
    this.elements = {
      loading: document.getElementById("loading"),
      responseContent: document.getElementById("response-content"),
      splitLayout: document.getElementById("split-layout"),
      fullContent: document.getElementById("full-content"),
      textContent: document.getElementById("text-content"),
      codeContent: document.getElementById("code-content"),
      responsePanel: document.getElementById("response-panel"),
      fullMarkdown: document.getElementById("response-panel") || document.getElementById("full-markdown"),
      screenshotQueueBadge: document.getElementById("screenshotQueueBadge"),
      copyResponseBtn: document.getElementById("copy-response-btn"),
    };

    // Validate required elements
    const requiredElements = ["loading", "responseContent"];
    for (const elementKey of requiredElements) {
      if (!this.elements[elementKey]) {
        throw new Error(`Required element '${elementKey}' not found`);
      }
    }
  }

  setupEventListeners() {
    const ipcRenderer = (typeof window !== 'undefined' && window.ipcRenderer) || (typeof require === 'function' ? require('electron').ipcRenderer : null);

    logger.debug("Setting up event listeners", {
      component: "LLMResponseWindowUI",
    });

    // Test IPC connection
    try {
      ipcRenderer.send("test-connection");
      logger.debug("IPC connection test sent", {
        component: "LLMResponseWindowUI",
      });
    } catch (error) {
      logger.error("IPC connection test failed", {
        component: "LLMResponseWindowUI",
        error: error.message,
      });
    }

    // Core event handlers with enhanced logging
    ipcRenderer.on("show-loading", () => {
      logger.debug("show-loading event received", {
        component: "LLMResponseWindowUI",
      });
      this.showLoadingState();
    });

    ipcRenderer.on("display-llm-response", (event, data) => {
      logger.info("display-llm-response event received - ENTRY POINT", {
        component: "LLMResponseWindowUI",
        hasData: !!data,
        dataKeys: data ? Object.keys(data) : [],
        contentLength: data?.content?.length || 0,
        responseLength: data?.response?.length || 0,
        eventOrigin: event ? "valid" : "invalid",
        timestamp: new Date().toISOString(),
      });

      // Add a small delay to ensure DOM is ready
      setTimeout(() => {
        this.handleDisplayResponse(data);
      }, 50);
    });

    ipcRenderer.on("llm-stream-chunk", (event, data) => {
      this.handleStreamChunk(data);
    });

    ipcRenderer.on("clear-response-panel", () => {
      this.handleClearResponsePanel();
    });

    ipcRenderer.on("stream-llm-token", (event, token) => {
      this.handleStreamToken(token);
    });

    ipcRenderer.on("screenshot-queue-updated", (event, payload) => {
      const data = payload || event || {};
      const badge = this.elements.screenshotQueueBadge || document.getElementById("screenshotQueueBadge");
      if (badge) {
        const count = data.count || 0;
        badge.textContent = data.message || `📸 Screenshots Queued: ${count} (Press Ctrl+Enter to Solve)`;
      }
    });

    // Toggle full overlay DOM visibility (hides entire root, including header/toolbar)
    ipcRenderer.on("toggle-overlay-visibility", () => {
      const rootElement = document.getElementById("app-root") || document.body;
      if (!rootElement) return;
      rootElement.style.display = rootElement.style.display === "none" ? "" : "none";
    });

    // Interaction state handlers
    ipcRenderer.on("interaction-enabled", () => {
      logger.debug("interaction-enabled event received", {
        component: "LLMResponseWindowUI",
      });
      this.handleInteractionEnabled();
    });

    ipcRenderer.on("interaction-disabled", () => {
      logger.debug("interaction-disabled event received", {
        component: "LLMResponseWindowUI",
      });
      this.handleInteractionDisabled();
    });

    // Window event handlers
    this.setupWindowEventHandlers();

    // Keyboard event handlers
    this.setupKeyboardHandlers();

    logger.debug("Event listeners setup complete", {
      component: "LLMResponseWindowUI",
    });

    // Add a test method to verify setup
    window.testLLMResponse = () => {
      logger.info("Manual test triggered");
      this.handleDisplayResponse({
        content: "Test content from manual trigger",
        metadata: { skill: "test" },
      });
    };
  }

  setupWindowEventHandlers() {
    window.addEventListener("focus", () => {
      logger.debug("LLM Response window focused", {
        component: "LLMResponseWindowUI",
      });
    });

    window.addEventListener("beforeunload", () => {
      logger.debug("LLM Response window closing", {
        component: "LLMResponseWindowUI",
      });
    });
  }

  setupKeyboardHandlers() {
    document.addEventListener("keydown", (e) => {
      this.handleKeyDown(e);
    });
    if (this.elements.copyResponseBtn) {
      this.elements.copyResponseBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.copyResponsePanelText();
      });
    }
  }

  stripFenceMarkers(text) {
    if (typeof text !== 'string' || !text) return '';
    return text.replace(/```[a-zA-Z0-9_+-]*\r?\n?/g, '').replace(/```/g, '');
  }

  getResponsePanelElement() {
    return this.elements.responsePanel || this.elements.fullMarkdown || document.getElementById('response-panel') || document.getElementById('full-markdown');
  }

  async copyResponsePanelText() {
    try {
      const panel = this.getResponsePanelElement();
      if (!panel) return;
      const text = panel.textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      }
      const btn = this.elements.copyResponseBtn || document.getElementById('copy-response-btn');
      if (btn) {
        const old = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = old || 'Copy'; btn.classList.remove('copied'); }, 1200);
      }
    } catch (e) {
      logger.debug('Copy failed', { error: e.message, component: 'LLMResponseWindowUI' });
    }
  }

  configureMarked() {
    if (typeof marked !== "undefined") {
      marked.setOptions({
        highlight: function (code, lang) {
          if (typeof Prism !== "undefined" && Prism.languages[lang]) {
            return Prism.highlight(code, Prism.languages[lang], lang);
          }
          return code;
        },
        breaks: true,
        gfm: true,
      });
    }
  }

  handleDisplayResponse(data) {
    try {
      logger.info("LLM Response received - START", {
        component: "LLMResponseWindowUI",
        dataExists: !!data,
        timestamp: new Date().toISOString(),
      });

      // Comprehensive data validation
      if (typeof data === 'string') {
        data = { response: data, content: data };
      }

      if (!data || typeof data !== "object") {
        throw new Error(
          "Invalid data: expected object, received " + typeof data
        );
      }

      const response = data.content || data.response;
      if (!response || typeof response !== "string") {
        throw new Error("Invalid response: expected string content");
      }

      if (response.trim().length === 0) {
        throw new Error("Empty response content");
      }

      logger.info("Valid response data found", {
        component: "LLMResponseWindowUI",
        responseLength: response.length,
      });

      // Rest of the method...
      if (window.innerWidth < 500 || window.innerHeight < 300) {
        this.handleWindowExpansion(data);
      } else {
        this.displayResponseContent(data);
      }
    } catch (error) {
      logger.error("Failed to handle display response", {
        component: "LLMResponseWindowUI",
        error: error.message,
        stack: error.stack,
      });

      this.hideLoadingState();
      this.displayErrorMessage(`Error processing response: ${error.message}`);
    }
  }

  handleStreamChunk(data) {
    try {
      const chunk = typeof data === 'string' ? data : (data?.chunk || '');
      const isFirst = data?.isFirst || false;
      const fullText = data?.fullText || '';
      const panel = this.getResponsePanelElement();

      if (isFirst || !this.streamingAccumulator) {
        this.streamingAccumulator = '';
        this.hideLoadingState();
        this.showResponseContent();
        this.elements.splitLayout?.classList.add("hidden");
        this.elements.fullContent?.classList.remove("hidden");
        if (panel) {
          panel.style.whiteSpace = 'pre';
          panel.style.tabSize = '4';
          panel.textContent = '';
        }
      }

      const cleaned = this.stripFenceMarkers(fullText || ((this.streamingAccumulator || '') + chunk));
      this.streamingAccumulator = cleaned;

      if (panel) {
        panel.textContent = cleaned;
        const container = document.querySelector('.full-content-inner');
        if (container) container.scrollTop = container.scrollHeight;
      }
    } catch (e) {
      logger.debug("Error handling stream chunk", { error: e.message });
    }
  }

  handleClearResponsePanel() {
    try {
      this.streamingAccumulator = '';
      this.streamingRenderMode = 'text';
      this.hideLoadingState();
      this.showResponseContent();
      this.elements.splitLayout?.classList.add("hidden");
      this.elements.fullContent?.classList.remove("hidden");
      const panel = this.getResponsePanelElement();
      if (panel) {
        panel.textContent = '';
        panel.dataset.streaming = 'true';
        panel.style.whiteSpace = 'pre';
        panel.style.tabSize = '4';
      }
    } catch (e) {
      logger.debug("Error clearing response panel", { error: e.message });
    }
  }

  handleStreamToken(token) {
    try {
      if (typeof this.streamingAccumulator !== 'string') {
        this.streamingAccumulator = '';
      }
      const panel = this.getResponsePanelElement();
      if (this.streamingAccumulator.length === 0) {
        this.hideLoadingState();
        this.showResponseContent();
        this.elements.splitLayout?.classList.add("hidden");
        this.elements.fullContent?.classList.remove("hidden");
        this.streamingRenderMode = 'text';
        if (panel) {
          panel.style.whiteSpace = 'pre';
          panel.style.tabSize = '4';
          panel.textContent = '';
          panel.dataset.streaming = 'true';
        }
      }

      const chunk = this.stripFenceMarkers(String(token || ''));
      if (!chunk) return;
      this.streamingAccumulator += chunk;

      if (panel) {
        // Append via textContent to preserve leading spaces, indentation, and newlines
        panel.textContent = this.streamingAccumulator;
        const container = document.querySelector('.full-content-inner');
        if (container) container.scrollTop = container.scrollHeight;
      }
    } catch (e) {
      logger.debug("Error handling stream token", { error: e.message });
    }
  }

  async handleWindowExpansion(data) {
    try {
      logger.debug("Window appears to be compact size, requesting expansion", {
        component: "LLMResponseWindowUI",
      });

      const response = data.content || data.response;
      if (!response) {
        throw new Error("No response data available for expansion calculation");
      }

      const codeBlocks = this.extractCodeBlocks(response);
      const contentMetrics = this.calculateContentMetrics(response, codeBlocks);

      const ipcRenderer = (typeof window !== 'undefined' && window.ipcRenderer) || (typeof require === 'function' ? require('electron').ipcRenderer : null);

      // Add timeout to prevent hanging
      const expansionPromise = ipcRenderer.invoke(
        "expand-llm-window",
        contentMetrics
      );
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Window expansion timeout")), 5000)
      );

      const result = await Promise.race([expansionPromise, timeoutPromise]);

      logger.debug("Window expansion completed", {
        component: "LLMResponseWindowUI",
        result,
      });

      // Use a more reliable delay mechanism
      await new Promise((resolve) => setTimeout(resolve, 200));
      this.displayResponseContent(data);
    } catch (error) {
      logger.error("Failed to expand window", {
        component: "LLMResponseWindowUI",
        error: error.message,
      });

      // Fallback to display content without expansion
      this.displayResponseContent(data);
    }
  }

  displayResponseContent(data) {
    try {
      logger.debug("displayResponseContent called - START", {
        component: "LLMResponseWindowUI",
        dataKeys: Object.keys(data),
        hasContent: !!data.content,
        hasResponse: !!data.response,
      });

      // Always hide loading state first
      logger.debug("Hiding loading state...");
      this.hideLoadingState();

      // Always show response content
      logger.debug("Showing response content...");
      this.showResponseContent();

      // Validate elements exist
      if (!this.elements.responseContent) {
        logger.error("Response content element not found!", {
          component: "LLMResponseWindowUI",
        });
        return;
      }

      // Check both content and response properties for compatibility
      const response = data.content || data.response;
      if (!response) {
        logger.error("No response data received", {
          component: "LLMResponseWindowUI",
          dataKeys: Object.keys(data),
          dataContent: data,
        });

        // Show error message instead of staying in loading state
        this.displayErrorMessage("No content received");
        return;
      }

      logger.info("Processing response content", {
        component: "LLMResponseWindowUI",
        responseLength: response.length,
        responsePreview: response.substring(0, 200) + "...",
      });

      // Check if response contains code blocks
      const codeBlocks = this.extractCodeBlocks(response);
      this.hasCode = codeBlocks.length > 0;

      logger.debug("Code analysis complete", {
        component: "LLMResponseWindowUI",
        hasCode: this.hasCode,
        codeBlockCount: codeBlocks.length,
      });

      // Calculate content metrics for dynamic sizing
      const contentMetrics = this.calculateContentMetrics(response, codeBlocks);

      logger.info("About to display response content", {
        component: "LLMResponseWindowUI",
        hasCode: this.hasCode,
        responseLength: response.length,
        layoutType: "full",
      });

      // Display content - Universal single-column full layout across ALL skills
      logger.debug("Displaying universal single-column full layout...");
      this.displayFullLayout(response);

      logger.info("Response content displayed successfully", {
        component: "LLMResponseWindowUI",
        layoutType: "full",
      });

      // Setup additional features
      this.setupScrolling();
      this.requestWindowResize(contentMetrics);

      // Final verification
      setTimeout(() => {
        const isLoadingHidden = this.elements.loading
          ? this.elements.loading.classList.contains("hidden")
          : true;
        const isContentVisible = this.elements.responseContent
          ? !this.elements.responseContent.classList.contains("hidden")
          : false;

        logger.info("Display state verification", {
          component: "LLMResponseWindowUI",
          loadingHidden: isLoadingHidden,
          contentVisible: isContentVisible,
          windowVisible: !document.hidden,
        });

        if (!isLoadingHidden || !isContentVisible) {
          logger.warn("Display state inconsistent - forcing correction", {
            component: "LLMResponseWindowUI",
          });
          this.hideLoadingState();
          this.showResponseContent();
        }
      }, 100);

      logger.debug("displayResponseContent completed - END");
    } catch (error) {
      logger.error("Failed to display response content", {
        component: "LLMResponseWindowUI",
        error: error.message,
        stack: error.stack,
      });

      // Always try to hide loading and show some content
      this.hideLoadingState();
      this.displayErrorMessage("Error displaying content: " + error.message);
    }
  }

  displayErrorMessage(message) {
    logger.info("Displaying error message", {
      component: "LLMResponseWindowUI",
      message,
    });

    this.showResponseContent();

    if (this.elements.fullContent && this.elements.fullMarkdown) {
      this.elements.splitLayout?.classList.add("hidden");
      this.elements.fullContent?.classList.remove("hidden");
      this.elements.fullMarkdown.innerHTML = `<div class="error-message" style="color: #ff6b6b; padding: 20px; text-align: center; font-family: monospace;">${message}</div>`;
    }
  }

  async requestWindowResize(contentMetrics) {
    try {
      setTimeout(async () => {
        logger.debug("Requesting window resize based on content metrics", {
          component: "LLMResponseWindowUI",
          metrics: contentMetrics,
        });

        const ipcRenderer = (typeof window !== 'undefined' && window.ipcRenderer) || (typeof require === 'function' ? require('electron').ipcRenderer : null);
        const result = await ipcRenderer.invoke(
          "resize-llm-window-for-content",
          contentMetrics
        );

        logger.debug("Window resize result", {
          component: "LLMResponseWindowUI",
          result,
        });
      }, 200);
    } catch (error) {
      logger.error("Failed to resize window", {
        component: "LLMResponseWindowUI",
        error: error.message,
      });
    }
  }

  handleInteractionEnabled() {
    this.isInteractive = true;
    document.body.classList.add("interactive-scrolling");
    this.enableScrolling();

    logger.debug("Interaction mode enabled", {
      component: "LLMResponseWindowUI",
    });
  }

  handleInteractionDisabled() {
    this.isInteractive = false;
    document.body.classList.remove("interactive-scrolling");
    this.disableScrolling();

    logger.debug("Interaction mode disabled", {
      component: "LLMResponseWindowUI",
    });
  }

  handleKeyDown(e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.copyResponsePanelText();
      return;
    }
    if (!this.isInteractive) return;

    const activeElement = document.activeElement;
    let targetElement = null;

    // Find the currently focused scrollable element
    for (let element of this.scrollableElements) {
      if (element === activeElement || element.contains(activeElement)) {
        targetElement = element;
        break;
      }
    }

    // Default to first scrollable element if none focused
    if (!targetElement && this.scrollableElements.length > 0) {
      targetElement = this.scrollableElements[0];
    }

    if (!targetElement) return;

    const scrollAmount = 50;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        targetElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
        break;
      case "ArrowDown":
        e.preventDefault();
        targetElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
        break;
      case "ArrowLeft":
        e.preventDefault();
        targetElement.scrollBy({ left: -scrollAmount, behavior: "smooth" });
        break;
      case "ArrowRight":
        e.preventDefault();
        targetElement.scrollBy({ left: scrollAmount, behavior: "smooth" });
        break;
      case "PageUp":
        e.preventDefault();
        targetElement.scrollBy({
          top: -targetElement.clientHeight * 0.8,
          behavior: "smooth",
        });
        break;
      case "PageDown":
        e.preventDefault();
        targetElement.scrollBy({
          top: targetElement.clientHeight * 0.8,
          behavior: "smooth",
        });
        break;
      case "Home":
        e.preventDefault();
        targetElement.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "End":
        e.preventDefault();
        targetElement.scrollTo({
          top: targetElement.scrollHeight,
          behavior: "smooth",
        });
        break;
    }
  }

  showLoadingState() {
    if (this.elements.loading) {
      this.elements.loading.classList.remove("hidden");
    }

    if (this.elements.responseContent) {
      this.elements.responseContent.classList.add("hidden");
    }

    logger.debug("Loading state shown", { component: "LLMResponseWindowUI" });
  }

  hideLoadingState() {
    if (this.elements.loading) {
      this.elements.loading.classList.add("hidden");
      logger.debug('Loading element hidden with "hidden" class', {
        component: "LLMResponseWindowUI",
      });
    } else {
      logger.warn("Loading element not found!", {
        component: "LLMResponseWindowUI",
      });
    }

    logger.debug("Loading state hidden", { component: "LLMResponseWindowUI" });
  }

  showResponseContent() {
    if (this.elements.responseContent) {
      this.elements.responseContent.classList.remove("hidden");
      logger.debug("Response content element shown (hidden class removed)", {
        component: "LLMResponseWindowUI",
      });
    } else {
      logger.warn("Response content element not found!", {
        component: "LLMResponseWindowUI",
      });
    }

    logger.debug("Response content shown", {
      component: "LLMResponseWindowUI",
    });
  }

  extractCodeBlocks(text) {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const blocks = [];
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      blocks.push({
        language: match[1] || "text",
        code: match[2].trim(),
        fullMatch: match[0],
      });
    }

    return blocks;
  }

  calculateContentMetrics(response, codeBlocks) {
    const lineCount = response.split("\n").length;
    const hasLongLines = response.split("\n").some((line) => line.length > 80);
    const codeBlockCount = codeBlocks.length;
    const hasCode = codeBlockCount > 0;
    const isLongContent = lineCount > 30;
    const hasMultipleCodeBlocks = codeBlockCount > 2;

    return {
      lineCount,
      hasLongLines,
      codeBlocks: codeBlockCount,
      hasCode,
      isLongContent,
      hasMultipleCodeBlocks,
      complexity:
        isLongContent || hasMultipleCodeBlocks
          ? "high"
          : hasCode
          ? "medium"
          : "low",
    };
  }

  displaySplitLayout(response, codeBlocks) {
    // Universal single-column full-width layout across ALL skill modes
    this.displayFullLayout(response);
  }

  displayFullLayout(response) {
    this.currentLayout = "full";
    this.elements.splitLayout?.classList.add("hidden");
    this.elements.fullContent?.classList.remove("hidden");

    const panel = this.getResponsePanelElement();
    const raw = this.stripFenceMarkers(String(response || ""));
    if (panel) {
      panel.style.whiteSpace = 'pre';
      panel.style.tabSize = '4';
      panel.textContent = raw;
      const container = document.querySelector('.full-content-inner');
      if (container) container.scrollTop = 0;
    }

    logger.info("Full layout displayed (unified pre)", { component: "LLMResponseWindowUI", responseLength: raw.length });
  }

  renderCodeBlocks(codeBlocks) {
    if (!this.elements.codeContent) return;

    this.elements.codeContent.innerHTML = "";

    if (codeBlocks.length === 0) {
      this.elements.codeContent.innerHTML =
        '<div class="no-code">No code examples found</div>';
    } else {
      codeBlocks.forEach((block, index) => {
        const codeBlock = document.createElement("div");
        codeBlock.className = "code-block";
        codeBlock.innerHTML = `
                    <div class="code-header">${block.language.toUpperCase()}</div>
                    <div class="code-content">
                        <pre><code class="language-${
                          block.language
                        }">${this.escapeHtml(block.code)}</code></pre>
                    </div>
                `;
        this.elements.codeContent.appendChild(codeBlock);
      });
    }
  }

  highlightCode() {
    if (typeof Prism !== "undefined") {
      Prism.highlightAll();
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  setupScrolling() {
    setTimeout(() => {
      this.scrollableElements = [
        document.querySelector(".full-content-inner"),
        document.querySelector(".text-panel .panel-content"),
        document.querySelector(".code-panel .panel-content"),
      ].filter((el) => el !== null);

      logger.debug("Scrollable elements found", {
        component: "LLMResponseWindowUI",
        count: this.scrollableElements.length,
      });

      // Reset scroll positions and ensure elements are focusable
      this.scrollableElements.forEach((element) => {
        element.scrollTop = 0;
        element.scrollLeft = 0;
        element.setAttribute("tabindex", "0");
      });

      // Enable scrolling if interactive mode is on
      if (this.isInteractive) {
        this.enableScrolling();
      }
    }, 100);
  }

  enableScrolling() {
    logger.debug("Enabling scrolling", {
      component: "LLMResponseWindowUI",
      elementCount: this.scrollableElements.length,
    });

    this.scrollableElements.forEach((element) => {
      if (element) {
        element.style.scrollBehavior = "smooth";

        // Remove any existing listeners first to prevent duplicates
        element.removeEventListener("mouseenter", this.handleMouseEnter);
        element.removeEventListener("mouseleave", this.handleMouseLeave);
        element.removeEventListener("wheel", this.handleWheelScroll);

        // Add listeners with proper binding
        element.addEventListener("mouseenter", this.handleMouseEnter, {
          passive: true,
        });
        element.addEventListener("mouseleave", this.handleMouseLeave, {
          passive: true,
        });
        element.addEventListener("wheel", this.handleWheelScroll, {
          passive: false,
        });
      }
    });
  }

  destroy() {
    try {
      // Remove all event listeners
      this.disableScrolling();

      // Remove keyboard handlers
      document.removeEventListener("keydown", this.handleKeyDown);

      // Clear any pending timeouts (you'd need to track these)
      // clearTimeout(this.expansionTimeout);

      // Clear references
      this.scrollableElements = [];
      this.elements = {};

      logger.info("LLMResponseWindowUI destroyed", {
        component: "LLMResponseWindowUI",
      });
    } catch (error) {
      logger.error("Error during cleanup", {
        component: "LLMResponseWindowUI",
        error: error.message,
      });
    }
  }

  // Add method to check if dependencies are available
  checkDependencies() {
    const missing = [];

    if (typeof marked === "undefined") {
      missing.push("marked");
    }

    if (typeof Prism === "undefined") {
      missing.push("Prism");
    }

    try {
      require("electron");
    } catch (e) {
      missing.push("electron");
    }

    if (missing.length > 0) {
      logger.warn("Missing dependencies", {
        component: "LLMResponseWindowUI",
        missing: missing,
      });
      return false;
    }

    return true;
  }

  disableScrolling() {
    logger.debug("Disabling scrolling", { component: "LLMResponseWindowUI" });

    this.scrollableElements.forEach((element) => {
      if (element) {
        element.removeEventListener("mouseenter", this.handleMouseEnter);
        element.removeEventListener("mouseleave", this.handleMouseLeave);
        element.removeEventListener("wheel", this.handleWheelScroll);
      }
    });
  }

  handleMouseEnter(e) {
    e.target.focus({ preventScroll: true });
    e.target.style.cursor = "grab";
  }

  handleMouseLeave(e) {
    e.target.style.cursor = "default";
  }

  handleWheelScroll(e) {
    logger.debug("Wheel scroll detected", { component: "LLMResponseWindowUI" });
  }

  // Public methods for external access
  getCurrentLayout() {
    return this.currentLayout;
  }

  hasCodeContent() {
    return this.hasCode;
  }

  isInteractiveMode() {
    return this.isInteractive;
  }
}

// Initialize when DOM is ready - Re-enabled for better error handling
let llmResponseWindowUI;
document.addEventListener('DOMContentLoaded', () => {
    llmResponseWindowUI = new LLMResponseWindowUI();
    
    // Global access for debugging
    window.llmResponseWindowUI = llmResponseWindowUI;
});

module.exports = LLMResponseWindowUI;
