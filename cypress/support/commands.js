// Custom Cypress commands designed specifically for TechFeatures Chatbot.jsx

/**
 * Opens the Chatbot widget if not already opened
 */
Cypress.Commands.add("openChatbot", () => {
  cy.get("body").then(($body) => {
    if (!$body.find(".chat-window.open-chat-window").length) {
      cy.get(".chat-button", { timeout: 15000 }).should("be.visible").click();
    }
  });
  cy.get(".chat-window.open-chat-window", { timeout: 10000 }).should("be.visible");
});

/**
 * Clears the chat session using the official Chatbot UI flow:
 * 1. Clicks the three-dot menu icon (.bi-three-dots-vertical) in the chat header
 * 2. Clicks the 'Clear' confirmation button in ConfirmModal (triggers performClearSession)
 * 3. Completely wipes localStorage and cookies
 */
Cypress.Commands.add("clearChatSession", () => {
  cy.get("body").then(($body) => {
    // If chat window is open, use the three-dot clear button
    if ($body.find(".chat-window.open-chat-window").length > 0) {
      if ($body.find(".bi-three-dots-vertical").length > 0) {
        cy.get(".bi-three-dots-vertical").click({ force: true });
        cy.contains("button", "Clear", { timeout: 5000 }).click({ force: true });
        cy.wait(800);
      }
    } else if ($body.find(".chat-button").length > 0) {
      // If chat window is closed, open it and clear
      cy.get(".chat-button").click({ force: true });
      cy.wait(500);
      cy.get("body").then(($b) => {
        if ($b.find(".bi-three-dots-vertical").length > 0) {
          cy.get(".bi-three-dots-vertical").click({ force: true });
          cy.contains("button", "Clear", { timeout: 5000 }).click({ force: true });
          cy.wait(800);
        }
      });
    }
  });

  // Purge browser storage to guarantee 100% fresh session
  cy.clearLocalStorage();
  cy.clearCookies();
  cy.window().then((win) => {
    win.localStorage.clear();
    win.sessionStorage.clear();
  });
});

/**
 * Clicks 'Start New Chat' button if present on the screen
 */
Cypress.Commands.add("startNewChat", () => {
  cy.get("body").then(($body) => {
    if ($body.find(".start-new-chat-btn").length > 0) {
      cy.get(".start-new-chat-btn").first().click();
    }
  });
});

/**
 * Sends a message into the chat textarea and clicks the send button
 */
Cypress.Commands.add("sendChatMessage", (message) => {
  // Count bot markdown messages existing in the DOM before sending this new message
  cy.document().then(($doc) => {
    const existingBot = $doc.querySelectorAll(
      ".bot-message-row .message-bubble.bot-message .chat-markdown, .message-bubble.bot-message .chat-markdown"
    );
    Cypress.env("prevBotCount", existingBot.length);
    Cypress.env("lastSentQuestion", (message || "").trim());
  });

  cy.get("textarea.text-box", { timeout: 10000 })
    .should("be.visible")
    .clear()
    .type(message, { delay: 10 });

  cy.get(".send-button", { timeout: 5000 })
    .should("be.visible")
    .click();
});

/**
 * Waits up to 2 minutes (120s) for the chatbot response.
 * Strictly selects ONLY bot messages (never user messages),
 * ensures thinking dots are gone and a new bot reply has appeared.
 * If 2 minutes elapse without a response, cleanly returns a TIMEOUT tag.
 */
Cypress.Commands.add("waitForBotReply", (timeout = 120000, sentQuery = "") => {
  cy.log(`Waiting for bot reply (up to 2 minutes / ${timeout / 1000}s)...`);
  const prevCount = Cypress.env("prevBotCount") !== undefined ? Cypress.env("prevBotCount") : 0;
  const targetQuestion = (sentQuery || Cypress.env("lastSentQuestion") || "").trim().toLowerCase();

  return cy.document().then({ timeout: timeout + 5000 }, ($doc) => {
    return new Cypress.Promise((resolve) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        // Check for thinking / typing indicators
        const thinking = $doc.querySelector(".thinking-dots");

        // MUST strictly select ONLY bot message markdown bubbles (NEVER user bubbles)
        const botMessages = $doc.querySelectorAll(
          ".bot-message-row .message-bubble.bot-message .chat-markdown, .message-bubble.bot-message .chat-markdown"
        );

        // A new bot message must have arrived (count > prevCount) and thinking dots must be gone
        if (!thinking && botMessages.length > prevCount) {
          const lastMsg = botMessages[botMessages.length - 1];

          // Strict guard: verify element is NOT inside user-message or user-message-row
          if (!lastMsg.closest(".user-message") && !lastMsg.closest(".user-message-row")) {
            const text = (lastMsg.innerText || lastMsg.textContent || "").trim();
            if (text.length > 0) {
              // Safety check: if text is identically the question, ensure it didn't grab the user input
              if (targetQuestion && text.toLowerCase() === targetQuestion) {
                if (lastMsg.closest(".user-message-row") || lastMsg.closest(".user-message")) {
                  return; // Keep waiting
                }
              }

              clearInterval(interval);
              return resolve(text);
            }
          }
        }

        // Check if 2-minute (120s) timeout has elapsed
        if (Date.now() - startTime >= timeout) {
          clearInterval(interval);
          return resolve("[TIMEOUT: No response received within 120s]");
        }
      }, 500);
    });
  });
});

