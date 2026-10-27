import "./commands";

// Ignore uncaught exceptions from third-party scripts on live site (e.g. Google Analytics, fonts, etc.)
Cypress.on("uncaught:exception", (err, runnable) => {
  return false;
});

