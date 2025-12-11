class ChatbotClient {
  constructor() {
    const urlParams = new URLSearchParams(window.location.search);
    const serverFromUrl = urlParams.get("server");
    const savedConfig = localStorage.getItem("chatbot_config");
    const savedUrl = savedConfig ? JSON.parse(savedConfig).serverUrl : null;

    this.serverUrl = serverFromUrl || savedUrl || "http:localhost:8000";
    this.sessionId = null;
    this.branchServiceId = null;
    this.ws = null;
    this.authType = "none";
    this.authToken = "";
    this.token = "";
  }

  // ============= INITIALIZATION =============
  init() {
    this.setupEventListeners();
    this.restoreConfig();
  }

  setupEventListeners() {
    // Configuration
    document
      .getElementById("authType")
      .addEventListener("change", (e) => this.updateAuthUI(e.target.value));
    document
      .getElementById("loadConfig")
      .addEventListener("click", () => this.loadConfig());
    document
      .getElementById("createSession")
      .addEventListener("click", () => this.createSession());
    document
      .getElementById("toggleConfig")
      .addEventListener("click", () => this.toggleConfigPanel());

    // Chat
    document
      .getElementById("sendBtn")
      .addEventListener("click", () => this.sendMessage());
    document.getElementById("userInput").addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
  }

  restoreConfig() {
    const saved = localStorage.getItem("chatbot_config");
    if (saved) {
      const config = JSON.parse(saved);
      document.getElementById("serverUrl").value =
        config.serverUrl || "http://localhost:8000";
      document.getElementById("authType").value = config.authType || "none";
      document.getElementById("authToken").value = config.authToken || "";
      document.getElementById("proxyToken").value = config.proxyToken || "";
      document.getElementById("branchServiceId").value =
        config.branchServiceId || "";
      this.updateAuthUI(config.authType || "none");
    }
  }

  saveConfig() {
    const config = {
      serverUrl: this.serverUrl,
      authType: document.getElementById("authType").value,
      authToken: document.getElementById("authToken").value,
      proxyToken: document.getElementById("proxyToken").value,
      branchServiceId: document.getElementById("branchServiceId").value,
    };
    localStorage.setItem("chatbot_config", JSON.stringify(config));
  }

  updateAuthUI(authType) {
    document.getElementById("authTokenSection").style.display =
      authType === "bearer" ? "flex" : "none";
    document.getElementById("proxyTokenSection").style.display =
      authType === "proxy" ? "flex" : "none";
  }

  toggleConfigPanel() {
    const panel = document.querySelector(".config-panel");
    const isCollapsed = panel.style.display === "none";
    panel.style.display = isCollapsed ? "flex" : "none";
  }

  // ============= CONFIGURATION =============
  async loadConfig() {
    const serverUrlInput = document.getElementById("serverUrl").value.trim();
    this.serverUrl = this.normalizeServerUrl(
      serverUrlInput || "http://localhost:8000"
    );
    this.authType = document.getElementById("authType").value;
    this.authToken = document.getElementById("authToken").value;
    this.token = document.getElementById("proxyToken").value;
    this.branchServiceId = document.getElementById("branchServiceId").value;
    this.sessionId = document.getElementById("sessionId").value || null;

    this.saveConfig();
    this.addSystemMessage(
      `Configuration loaded successfully. Server: ${this.serverUrl}`
    );

    if (this.sessionId) {
      this.loadSession();
    }
  }

  getHeaders() {
    const headers = {
      "Content-Type": "application/json",
    };

    if (this.authType === "bearer" && this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    } else if (this.authType === "proxy") {
      if (this.token) {
        headers["X-Proxy-Token"] = this.token;
      }
    }

    return headers;
  }

  normalizeServerUrl(url) {
    url = url.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "http://" + url;
    }
    // Remove trailing slash if present
    return url.replace(/\/$/, "");
  }

  // ============= SESSION MANAGEMENT =============
  async createSession() {
    this.loadConfig();

    console.log("[v0] branchServiceId value:", this.branchServiceId);
    console.log(
      "[v0] branchServiceId from input:",
      document.getElementById("branchServiceId").value
    );

    const branchServiceId = (this.branchServiceId || "").trim();

    if (!branchServiceId) {
      this.addSystemMessage("Error: Branch Service ID is required.");
      return;
    }

    try {
      this.updateStatus("Creating session...", "connecting");
      const response = await fetch(
        `${this.serverUrl}/api/v1/chatbot/sessions/`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            medium: "branch_service",
            resource_id: branchServiceId,
            title: `Chat ${new Date().toLocaleDateString()}`,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${errorText || response.statusText}`
        );
      }

      const data = await response.json();
      console.log("[v0] Session creation response:", data);
      this.sessionId = data.id || data.sessionId || data.session_id;
      document.getElementById("sessionId").value = this.sessionId;
      this.saveConfig();

      this.addSystemMessage(`Session created: ${this.sessionId}`);
      this.loadSessionTheme();
      this.connectWebSocket();
    } catch (error) {
      this.addSystemMessage(`Error creating session: ${error.message}`);
      this.updateStatus("Disconnected", "error");
      console.error(error);
    }
  }

  async loadSession() {
    if (!this.sessionId) {
      this.addSystemMessage("Error: Session ID is required.");
      return;
    }

    try {
      this.updateStatus("Loading session...", "connecting");
      const response = await fetch(
        `${this.serverUrl}/api/v1/chatbot/sessions/${this.sessionId}/`,
        {
          headers: this.getHeaders(),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const session = await response.json();
      this.branchServiceId = session.resource_id;
      document.getElementById("branchServiceId").value = this.branchServiceId;

      // Clear messages and reload
      document.getElementById("messagesContainer").innerHTML = "";

      // Add existing messages
      if (session.messages && session.messages.length > 0) {
        session.messages.forEach((msg) => {
          this.displayMessage(msg.role, msg.content, new Date(msg.created_at));
        });
      }

      this.saveConfig();
      this.loadSessionTheme();
      this.connectWebSocket();
      this.addSystemMessage("Session loaded successfully.");
    } catch (error) {
      this.addSystemMessage(`Error loading session: ${error.message}`);
      this.updateStatus("Disconnected", "error");
      console.error(error);
    }
  }

  async loadSessionTheme() {
    if (!this.branchServiceId) return;

    try {
      const response = await fetch(
        `${this.serverUrl}/api/v1/chatbot/chatbot-config/?branch_service_id=${this.branchServiceId}`,
        {
          headers: this.getHeaders(),
        }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const theme = await response.json();

      document.getElementById("displayName").textContent =
        theme.display_name || "Chatbot";
      document.getElementById("greeting").textContent =
        theme.greeting_message || "Hello!";

      // Apply theme colors
      const themeInfo = document.getElementById("themeInfo");
      const primaryColor = theme.primary_color || "#3498db";
      themeInfo.style.background = `linear-gradient(135deg, ${primaryColor} 0%, ${primaryColor}dd 100%)`;

      // Load avatar if available
      if (theme.avatar) {
        document.getElementById(
          "avatarPlaceholder"
        ).style.backgroundImage = `url(${theme.avatar})`;
        document.getElementById("avatarPlaceholder").style.backgroundSize =
          "cover";
      }
    } catch (error) {
      console.error("Error loading theme:", error);
    }
  }

  // ============= WEBSOCKET COMMUNICATION =============
  connectWebSocket() {
    if (!this.sessionId) {
      this.addSystemMessage("Error: Session ID is required to connect.");
      return;
    }

    const serverUrl = this.normalizeServerUrl(this.serverUrl);
    const isSecure = serverUrl.startsWith("https");
    const protocol = isSecure ? "wss" : "ws";
    // Extract host:port from URL (remove protocol)
    const hostPort = serverUrl.replace(/^http?:\/\//, "");

    let wsUrl = `${protocol}://${hostPort}/api/v1/chatbot/sessions/${this.sessionId}/`;

    // Add authentication query parameters if using proxy auth
    if (this.authType === "proxy") {
      const params = new URLSearchParams();
      if (this.token) params.append("token", this.token);

      if (params.toString()) {
        wsUrl += `?${params.toString()}`;
      }
    }

    console.log("[v0] Connecting to WebSocket:", wsUrl);

    try {
      this.updateStatus("Connecting...", "connecting");
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.updateStatus("Connected", "connected");
        document.getElementById("userInput").disabled = false;
        document.getElementById("sendBtn").disabled = false;
        this.addSystemMessage("WebSocket connected. Ready to chat.");
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleWebSocketMessage(data);
      };

      this.ws.onerror = (error) => {
        this.updateStatus("Error", "error");
        this.addSystemMessage(`WebSocket error: ${error}`);
        console.error("WebSocket error:", error);
      };

      this.ws.onclose = (event) => {
        if (event.code === 4001) {
          this.addSystemMessage(
            `WebSocket authentication failed: ${
              event.reason || "Invalid proxy token"
            }`
          );
        }
        this.updateStatus("Disconnected", "error");
        document.getElementById("userInput").disabled = true;
        document.getElementById("sendBtn").disabled = true;
        this.addSystemMessage("WebSocket disconnected.");
      };
    } catch (error) {
      this.updateStatus("Disconnected", "error");
      this.addSystemMessage(`Failed to connect: ${error.message}`);
      console.error(error);
    }
  }

  handleWebSocketMessage(data) {
    const type = data.type;

    switch (type) {
      case "connection_established":
        console.log("[v0] Connection established");
        break;

      case "user_message":
        this.displayMessage("user", data.message, new Date(data.timestamp));
        break;

      case "assistant_metadata":
        this.currentAssistantMetadata = data;
        break;

      case "assistant_message_chunk":
        this.addAssistantChunk(data.chunk);
        break;

      case "recommendations":
        this.displayRecommendations(data.items);
        break;

      case "follow_up_question":
        this.displayFollowUpQuestion(data.question);
        break;

      case "query_execution":
        this.currentQueryExecution = data;
        break;

      case "session_state":
        console.log("[v0] Session state:", data.state);
        break;

      case "response_complete":
        this.finalizeAssistantMessage();
        document.getElementById("userInput").value = "";
        document.getElementById("userInput").focus();
        break;

      case "error":
        this.addSystemMessage(`Error: ${data.error}`);
        break;

      default:
        console.log("[v0] Unknown message type:", type, data);
    }
  }

  sendMessage() {
    const message = document.getElementById("userInput").value.trim();
    if (!message || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!message) {
        this.addSystemMessage("Message cannot be empty.");
      } else if (!this.ws) {
        this.addSystemMessage("WebSocket is not connected.");
      } else {
        this.addSystemMessage("WebSocket is not ready. Please wait.");
      }
      return;
    }

    this.ws.send(
      JSON.stringify({
        message: message,
      })
    );

    this.currentAssistantMetadata = null;
    this.currentQueryExecution = null;
    this.currentAssistantContent = "";
  }

  // ============= MESSAGE DISPLAY =============
  displayMessage(role, content, timestamp) {
    const container = document.getElementById("messagesContainer");
    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${role}-message`;

    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.textContent = content;

    const timestampDiv = document.createElement("div");
    timestampDiv.className = "message-timestamp";
    timestampDiv.textContent = timestamp
      ? timestamp.toLocaleTimeString()
      : new Date().toLocaleTimeString();

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timestampDiv);

    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
  }

  addSystemMessage(content) {
    const container = document.getElementById("messagesContainer");
    const messageDiv = document.createElement("div");
    messageDiv.className = "message system-message";

    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.textContent = content;

    messageDiv.appendChild(contentDiv);
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
  }

  currentAssistantContent = "";
  currentAssistantMetadata = null;
  currentQueryExecution = null;

  addAssistantChunk(chunk) {
    const container = document.getElementById("messagesContainer");
    let lastMessage = container.lastElementChild;

    if (!lastMessage || !lastMessage.classList.contains("assistant-message")) {
      const messageDiv = document.createElement("div");
      messageDiv.className = "message assistant-message";

      const contentDiv = document.createElement("div");
      contentDiv.className = "message-content";
      contentDiv.id = "currentAssistantMessage";
      contentDiv.textContent = "";

      messageDiv.appendChild(contentDiv);
      container.appendChild(messageDiv);
      lastMessage = messageDiv;
    }

    this.currentAssistantContent += chunk;
    const contentDiv = document.getElementById("currentAssistantMessage");
    if (contentDiv) {
      contentDiv.textContent = this.currentAssistantContent;
    }

    container.scrollTop = container.scrollHeight;
  }

  finalizeAssistantMessage() {
    const contentDiv = document.getElementById("currentAssistantMessage");
    if (contentDiv) {
      contentDiv.removeAttribute("id");
    }
  }

  displayFollowUpQuestion(question) {
    const container = document.getElementById("messagesContainer");
    const questionDiv = document.createElement("div");
    questionDiv.className = "follow-up-question";
    questionDiv.textContent = `💡 Suggested: ${question}`;
    container.appendChild(questionDiv);
    container.scrollTop = container.scrollHeight;
  }

  displayRecommendations(items) {
    if (!items || items.length === 0) return;

    const container = document.getElementById("messagesContainer");
    const metaDiv = document.createElement("div");
    metaDiv.className = "message-meta";

    const btn = document.createElement("button");
    btn.className = "meta-button";
    btn.textContent = `📋 View Recommendations (${items.length})`;
    btn.onclick = () => this.showRecommendationsModal(items);

    metaDiv.appendChild(btn);
    container.appendChild(metaDiv);

    if (this.currentQueryExecution) {
      const queryBtn = document.createElement("button");
      queryBtn.className = "meta-button";
      queryBtn.textContent = "🔍 View Query Data";
      queryBtn.onclick = () =>
        this.showQueryDataModal(this.currentQueryExecution);
      metaDiv.appendChild(queryBtn);
    }

    container.scrollTop = container.scrollHeight;
  }

  showRecommendationsModal(items) {
    const content = document.getElementById("recommendationsContent");
    content.innerHTML = "";

    const listDiv = document.createElement("div");
    listDiv.className = "recommendations-list";

    items.forEach((item) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "recommendation-item";

      itemDiv.innerHTML = `
                <h4>${item.name || item.type}</h4>
                <div class="recommendation-reason">${
                  item.reason || "Recommended for you"
                }</div>
                <div class="recommendation-details">
                    <div class="json-display">
                        <pre>${JSON.stringify(
                          item.metadata || item,
                          null,
                          2
                        )}</pre>
                    </div>
                </div>
            `;

      listDiv.appendChild(itemDiv);
    });

    content.appendChild(listDiv);
    document.getElementById("recommendationsModal").classList.add("show");
  }

  showQueryDataModal(queryExecution) {
    const content = document.getElementById("queryDataContent");
    content.innerHTML = "";

    const infoDiv = document.createElement("div");
    infoDiv.innerHTML = `
            <h4>Query Type: ${queryExecution.query_type}</h4>
            <p><strong>Results Count:</strong> ${queryExecution.result_count}</p>
        `;

    const detailsDiv = document.createElement("div");
    detailsDiv.className = "json-display";
    detailsDiv.innerHTML = `<pre>${JSON.stringify(
      queryExecution,
      null,
      2
    )}</pre>`;

    content.appendChild(infoDiv);
    content.appendChild(detailsDiv);

    document.getElementById("queryDataModal").classList.add("show");
  }

  updateStatus(text, state) {
    const status = document.getElementById("connectionStatus");
    status.textContent = text;
    status.className = state;
  }
}

// ============= INITIALIZE =============
const client = new ChatbotClient();
document.addEventListener("DOMContentLoaded", () => {
  client.init();
});

function closeRecommendations() {
  document.getElementById("recommendationsModal").classList.remove("show");
}

function closeQueryData() {
  document.getElementById("queryDataModal").classList.remove("show");
}

// Close modals on background click
document.addEventListener("click", (e) => {
  if (e.target.id === "recommendationsModal") {
    closeRecommendations();
  }
  if (e.target.id === "queryDataModal") {
    closeQueryData();
  }
});
