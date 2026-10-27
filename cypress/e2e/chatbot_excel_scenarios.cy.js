/**
 * Data-Driven Cypress Testing directly loaded from Excel test cases.
 * Runs scenarios through the real Chatbot UI, extracts DOM text, evaluates with Groq,
 * and updates the Excel sheet automatically!
 */
describe("Data-Driven Excel Scenario Automation", () => {
  let testCases = [];

  before(() => {
    // Read test case(s) based on environment flags (e.g. --env testId=MS-025)
    cy.task("readExcelTestCases").then((cases) => {
      testCases = cases;
    });
  });

  beforeEach(() => {
    cy.clearChatSession();
    cy.visit("/home");
  });

  it("Executes and Evaluates Excel Scenarios in Browser UI", () => {
    cy.then(() => {
      if (testCases.length === 0) {
        cy.log("⏭️ [STATUS CHECK] All test cases are already marked as 'Tested'! (Pass --force to re-test).");
        return;
      }

      testCases.forEach((tc, idx) => {
        // Double-check test status first: skip if already marked as Tested
        const status = (tc.status || "").toLowerCase().trim();
        const isTested = status.includes("tested") && !status.includes("not tested") && !status.includes("untested");
        if (isTested && !Cypress.env("force")) {
          cy.log(`⏭️ [SKIPPED] Test ID ${tc.test_id} (Row ${tc.row_idx}) is ALREADY marked as 'Tested'. Skipping.`);
          return;
        }

        cy.log(`▶ Starting Scenario [${tc.test_id}]: ${tc.feature}`);
        cy.clearChatSession();
        cy.openChatbot();
        cy.startNewChat();

        const turns = (tc.turns && tc.turns.length > 0) ? tc.turns : [tc.input_raw];
        const turnResults = [];
        let scenarioTimedOut = false;

        cy.wrap(turns).each((turnQuery, tIdx) => {
          cy.then(() => {
            if (scenarioTimedOut) return;
            cy.log(`Turn ${tIdx + 1}: ${turnQuery}`);
            cy.sendChatMessage(turnQuery);

            // Wait up to 2 minutes (120s) for genuine bot response (ignoring user echo)
            cy.waitForBotReply(120000, turnQuery).then((botResponse) => {
              cy.log(`Turn ${tIdx + 1} Bot Response: ${botResponse.substring(0, 80)}...`);
              turnResults.push({
                turn: tIdx + 1,
                query: turnQuery,
                reply: botResponse
              });
              if (botResponse.startsWith("[TIMEOUT:")) {
                scenarioTimedOut = true;
              }
            });

            if (tIdx < turns.length - 1) {
              cy.wait(1500);
            }
          });
        }).then(() => {
          const lastTurn = turnResults[turnResults.length - 1] || {};
          const isTimeout = scenarioTimedOut || (lastTurn.reply && lastTurn.reply.startsWith("[TIMEOUT:"));

          let displayAnswer = "";
          if (turnResults.length > 1) {
            displayAnswer = turnResults.map(tr => `Turn ${tr.turn} User: ${tr.query}\nTurn ${tr.turn} Bot: ${tr.reply}`).join("\n");
          } else {
            displayAnswer = lastTurn.reply || "[ERROR: No response recorded]";
          }

          if (isTimeout) {
            cy.log(`❌ Scenario ${tc.test_id} timed out after 2 minutes! Recording in sheet and skipping...`);
            cy.task("writeExcelResult", {
              sheet: tc.sheet_name,
              row_idx: tc.row_idx,
              test_id: tc.test_id,
              score: 1,
              result: "FAIL",
              actual_output: "[TIMEOUT: No response received within 120s]",
              notes: "Timed Out: The chatbot backend did not respond within the 2-minute limit (120s max). Scenario skipped."
            });
          } else {
            // Evaluate using Groq task (1 - 10 rubric)
            cy.task("evaluateWithGroq", {
              scenario: tc.scenario || tc.feature || "General",
              userQuery: tc.input_raw,
              expectedResult: tc.expected,
              actualResponse: displayAnswer
            }).then((evalResult) => {
              cy.log(`★ Score: ${evalResult.score}/10 | Verdict: ${evalResult.result}`);
              cy.log(`Notes: ${evalResult.notes}`);

              // Save evaluated result to single Excel run file
              cy.task("writeExcelResult", {
                sheet: tc.sheet_name,
                row_idx: tc.row_idx,
                test_id: tc.test_id,
                score: evalResult.score,
                result: evalResult.result,
                actual_output: displayAnswer,
                notes: evalResult.notes
              });
            });
          }
        });

        if (idx < testCases.length - 1) {
          cy.wait(2000);
        }
      });
    });
  });
});
