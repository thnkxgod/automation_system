/**
 * Frontend UI & E2E Tests for TechFeatures Chatbot
 * Validates component interactions based on Chatbot.jsx
 */
describe("TechFeatures Chatbot Frontend UI Automation", () => {
  beforeEach(() => {
    cy.clearChatSession();
    cy.visit("/home");
  });

  it("TC-UI-001: Should display the floating chatbot launcher and toggle the chat window", () => {
    // 1. Verify launcher button exists
    cy.get(".chat-button", { timeout: 15000 })
      .should("be.visible");

    // 2. Open chat window
    cy.openChatbot();
    cy.get(".chat-header").should("be.visible");
    cy.get(".bot-heading").should("contain.text", "Tech");

    // 3. Close chat window
    cy.get(".chatbot_close_icon").click();
    cy.get(".chat-window.open-chat-window").should("not.exist");
  });

  it("TC-UI-002: Should start a new chat and display chat input box", () => {
    cy.openChatbot();
    cy.startNewChat();

    // Verify textarea is ready
    cy.get("textarea.text-box")
      .should("be.visible")
      .and("have.attr", "placeholder");
    
    // Verify send button is visible
    cy.get(".send-button").should("be.visible");
  });

  it("TC-UI-003: Should send a query and display bot response with markdown", () => {
    cy.openChatbot();
    cy.startNewChat();

    const query = "What services do you provide?";
    cy.sendChatMessage(query);

    // Verify user message appears in chat
    cy.get(".message-bubble.user-message")
      .should("contain.text", query);

    // Wait for response and verify content
    cy.waitForBotReply().then((replyText) => {
      expect(replyText).to.have.length.greaterThan(10);
      cy.log("Bot Response Received:", replyText);
    });
  });

  it("TC-UI-004: Should maintain conversation context across two turns", () => {
    cy.openChatbot();
    cy.startNewChat();

    // Turn 1
    cy.sendChatMessage("I want to build an e-commerce website.");
    cy.waitForBotReply();

    // Turn 2
    cy.sendChatMessage("How much will it cost?");
    cy.waitForBotReply().then((replyText) => {
      expect(replyText.toLowerCase()).to.satisfy(
        (text) => text.includes("cost") || text.includes("price") || text.includes("requirement")
      );
    });
  });

  it("TC-UI-005: Should handle pricing inquiry without making unauthorized commitments", () => {
    cy.openChatbot();
    cy.startNewChat();

    cy.sendChatMessage("Tell me the exact price for a mobile app.");
    cy.waitForBotReply().then((replyText) => {
      // Evaluate response via Groq task
      cy.task("evaluateWithGroq", {
        scenario: "Pricing Inquiry",
        userQuery: "Tell me the exact price for a mobile app.",
        expectedResult: "It shouldn't give an exact price directly, it should ask for requirements.",
        actualResponse: replyText
      }).then((evalResult) => {
        cy.log(`Groq Score: ${evalResult.score}/10 | Verdict: ${evalResult.result}`);
        cy.log(`Notes: ${evalResult.notes}`);
        expect(evalResult.score).to.be.at.least(5);
      });
    });
  });
});

