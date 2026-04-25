/*
 * practice.js — confidence-key practice drill.
 *
 * Three rounds × 6 trials, one per key per round (S/D/F/J/K/L). Each trial
 * shows a target phrase (e.g. "Probably Boula") and waits for the matching
 * key press. Green "Correct!" or red "Wrong" feedback after each press. Logs
 * trial-level data to Qualtrics embedded data (practice_data) and clicks the
 * next button when done.
 *
 * Hosted alongside experiment.js. Loaded from the practice Qualtrics question
 * via practice_loader.js.
 */

(function () {
  // ---------------------------------------------------------------------------
  // Base trial set: one per key. Replicated per round; each round shuffled
  // independently.
  // ---------------------------------------------------------------------------
  const PRACTICE_TRIALS_BASE = [
    { prompt: "Definitely Vekki", correctKey: "s" },
    { prompt: "Probably Vekki",   correctKey: "d" },
    { prompt: "Maybe Vekki",      correctKey: "f" },
    { prompt: "Maybe Boula",      correctKey: "j" },
    { prompt: "Probably Boula",   correctKey: "k" },
    { prompt: "Definitely Boula", correctKey: "l" },
  ];

  const VALID_KEYS = new Set(["s", "d", "f", "j", "k", "l"]);

  const CONFIG = {
    nRounds: 3,                  // 3 rounds × 6 trials = 18 total practice trials
    feedbackDurationMs: 800,
    itiDurationMs: 400,
    maxResponseTimeMs: 7000,
    backgroundColor: "#F5F5F5",
  };

  // Mutable state, set up by initPractice
  const State = {
    questionContext: null,
    container: null,
    trialOrder: [],
    trialIndex: 0,
    trialStartTime: 0,
    waitingForResponse: false,
    waitingForStart: false,
    keyHandlerInstalled: false,
    trialLog: [],
    proceedToNextPage: null,
  };

  // ---------------------------------------------------------------------------
  // DOM scaffolding
  // ---------------------------------------------------------------------------
  function buildHtml() {
    return `
      <style>
        body, html { background-color: ${CONFIG.backgroundColor} !important; }
        .practice-container { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 420px; font-family: Arial, sans-serif; background-color: ${CONFIG.backgroundColor}; padding: 20px; }
        .practice-container.hide-cursor, .practice-container.hide-cursor * { cursor: none !important; }
        .practice-prompt { font-size: 36px; font-weight: bold; margin: 30px 0; text-align: center; color: #222; min-height: 48px; }
        .practice-feedback { font-size: 24px; font-weight: bold; height: 36px; margin-bottom: 10px; }
        .practice-feedback.correct { color: green; }
        .practice-feedback.wrong { color: red; }
        .practice-keyrow { display: flex; gap: 6px; justify-content: center; margin-top: 20px; flex-wrap: wrap; }
        .practice-key { padding: 10px 14px; background-color: #ffffff; border: 1px solid #ccc; border-radius: 6px; min-width: 90px; text-align: center; font-size: 14px; }
        .practice-key b { font-size: 22px; }
        .practice-key.divider { border: none; background-color: transparent; min-width: 16px; padding: 0; }
        .practice-progress { font-size: 14px; color: #666; margin-top: 14px; }
        .practice-fixation { font-size: 48px; color: #333; }
        .practice-start-prompt { font-size: 18px; color: #555; margin-top: 20px; }
      </style>

      <div class="practice-container" id="practice-container">
        <div id="practice-start" style="text-align: center;">
          <div class="practice-fixation">+</div>
          <div class="practice-start-prompt">Press <strong>SPACEBAR</strong> to begin practice</div>
        </div>

        <div id="practice-trial" style="display: none;">
          <div class="practice-feedback" id="practice-feedback"></div>
          <div class="practice-prompt" id="practice-prompt"></div>
          <div class="practice-keyrow">
            <div class="practice-key"><b>S</b><br>Definitely Vekki</div>
            <div class="practice-key"><b>D</b><br>Probably Vekki</div>
            <div class="practice-key"><b>F</b><br>Maybe Vekki</div>
            <div class="practice-key divider"></div>
            <div class="practice-key"><b>J</b><br>Maybe Boula</div>
            <div class="practice-key"><b>K</b><br>Probably Boula</div>
            <div class="practice-key"><b>L</b><br>Definitely Boula</div>
          </div>
          <div class="practice-progress" id="practice-progress"></div>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Trial flow
  // ---------------------------------------------------------------------------
  function shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function showStartScreen() {
    document.getElementById("practice-start").style.display = "block";
    document.getElementById("practice-trial").style.display = "none";
    State.waitingForStart = true;
  }

  function buildTrialOrder() {
    // Each round is the 6 base trials shuffled independently.
    const order = [];
    for (let r = 0; r < CONFIG.nRounds; r++) {
      const round = shuffle(PRACTICE_TRIALS_BASE);
      for (let i = 0; i < round.length; i++) {
        order.push(Object.assign({}, round[i], { round: r + 1, trialInRound: i + 1 }));
      }
    }
    return order;
  }

  function startTrials() {
    document.getElementById("practice-start").style.display = "none";
    document.getElementById("practice-trial").style.display = "block";
    State.trialOrder = buildTrialOrder();
    State.trialIndex = 0;
    State.trialLog = [];
    runNextTrial();
  }

  function runNextTrial() {
    if (State.trialIndex >= State.trialOrder.length) {
      finishPractice();
      return;
    }
    const trial = State.trialOrder[State.trialIndex];
    document.getElementById("practice-prompt").textContent = trial.prompt;
    document.getElementById("practice-feedback").textContent = "";
    document.getElementById("practice-feedback").className = "practice-feedback";
    document.getElementById("practice-progress").textContent =
      `Round ${trial.round} of ${CONFIG.nRounds} · trial ${State.trialIndex + 1} of ${State.trialOrder.length}`;
    State.trialStartTime = Date.now();
    State.waitingForResponse = true;

    // Timeout
    State.timeoutId = setTimeout(() => {
      if (!State.waitingForResponse) return;
      handleResponse(null, true);
    }, CONFIG.maxResponseTimeMs);
  }

  function handleResponse(key, timeout) {
    if (!State.waitingForResponse) return;
    State.waitingForResponse = false;
    if (State.timeoutId) {
      clearTimeout(State.timeoutId);
      State.timeoutId = null;
    }

    const trial = State.trialOrder[State.trialIndex];
    const rt = Date.now() - State.trialStartTime;
    const correct = !timeout && key === trial.correctKey;

    const fb = document.getElementById("practice-feedback");
    if (timeout) {
      fb.textContent = "Too slow!";
      fb.className = "practice-feedback wrong";
    } else if (correct) {
      fb.textContent = "Correct!";
      fb.className = "practice-feedback correct";
    } else {
      fb.textContent = "Wrong";
      fb.className = "practice-feedback wrong";
    }

    State.trialLog.push({
      trialNum: State.trialIndex + 1,
      round: trial.round,
      trialInRound: trial.trialInRound,
      prompt: trial.prompt,
      correctKey: trial.correctKey,
      pressedKey: key,
      correct: correct,
      timeout: timeout,
      rt: rt,
      timestamp: Date.now(),
    });

    setTimeout(() => {
      // Clear the prompt & feedback for inter-trial gap
      document.getElementById("practice-prompt").textContent = "";
      document.getElementById("practice-feedback").textContent = "";
      document.getElementById("practice-feedback").className = "practice-feedback";
      State.trialIndex += 1;
      setTimeout(runNextTrial, CONFIG.itiDurationMs);
    }, CONFIG.feedbackDurationMs);
  }

  function finishPractice() {
    document.getElementById("practice-prompt").textContent = "Practice complete!";
    document.getElementById("practice-feedback").textContent = "";
    document.getElementById("practice-progress").textContent = "Continuing to the main task…";

    // Save to embedded data
    if (typeof Qualtrics !== "undefined") {
      try {
        Qualtrics.SurveyEngine.setEmbeddedData(
          "practice_data",
          JSON.stringify(State.trialLog)
        );
      } catch (e) {
        console.warn("Could not save practice_data to Qualtrics:", e);
      }
    }

    // Show cursor again
    const c = document.getElementById("practice-container");
    if (c) c.classList.remove("hide-cursor");
    document.body.style.cursor = "";

    // Advance after a short pause
    setTimeout(function () {
      if (typeof State.proceedToNextPage === "function") {
        State.proceedToNextPage();
      } else if (State.questionContext &&
                 typeof State.questionContext.clickNextButton === "function") {
        State.questionContext.clickNextButton();
      } else {
        const nextBtn = document.getElementById("NextButton");
        if (nextBtn) nextBtn.click();
      }
    }, 600);
  }

  // ---------------------------------------------------------------------------
  // Key handler
  // ---------------------------------------------------------------------------
  function installKeyHandler() {
    if (State.keyHandlerInstalled) return;
    State.keyHandlerInstalled = true;
    document.addEventListener("keydown", function (event) {
      if (event.repeat) return;
      const key = event.key.toLowerCase();

      // Spacebar starts the trials
      if ((key === " " || event.code === "Space") && State.waitingForStart) {
        event.preventDefault();
        State.waitingForStart = false;
        startTrials();
        return;
      }

      // Otherwise route to response handler if we're waiting for one
      if (State.waitingForResponse && VALID_KEYS.has(key)) {
        event.preventDefault();
        handleResponse(key, false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public init
  // ---------------------------------------------------------------------------
  function initPractice(qualtricsContext) {
    State.questionContext = qualtricsContext || null;
    if (qualtricsContext && typeof qualtricsContext.clickNextButton === "function") {
      State.proceedToNextPage = qualtricsContext.clickNextButton.bind(qualtricsContext);
    }

    // Set up the container in the Qualtrics question
    let host = document.body;
    if (qualtricsContext && typeof qualtricsContext.getQuestionContainer === "function") {
      const qContainer = qualtricsContext.getQuestionContainer();
      if (qContainer) {
        const inner = qContainer.querySelector(".Inner");
        if (inner) inner.style.display = "none";
        // Background match
        qContainer.style.backgroundColor = CONFIG.backgroundColor;
        if (typeof jQuery !== "undefined") {
          jQuery(".SkinInner").css("background-color", CONFIG.backgroundColor);
          jQuery(".Skin").css("background-color", CONFIG.backgroundColor);
          jQuery("body").css("background-color", CONFIG.backgroundColor);
        }
        document.body.style.backgroundColor = CONFIG.backgroundColor;

        let practiceDiv = qContainer.querySelector("#practice-host");
        if (!practiceDiv) {
          practiceDiv = document.createElement("div");
          practiceDiv.id = "practice-host";
          practiceDiv.style.width = "100%";
          practiceDiv.style.minHeight = "420px";
          practiceDiv.style.backgroundColor = CONFIG.backgroundColor;
          qContainer.appendChild(practiceDiv);
        }
        host = practiceDiv;
      }
    }
    State.container = host;
    host.innerHTML = buildHtml();

    // Hide cursor for consistency with main task
    const cont = document.getElementById("practice-container");
    if (cont) cont.classList.add("hide-cursor");
    document.body.style.cursor = "none";

    installKeyHandler();
    showStartScreen();
  }

  // Expose
  window.initPractice = initPractice;
})();
