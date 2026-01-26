/**
 * Adaptive Category Learning Experiment for Qualtrics
 *
 * This code implements a category learning experiment with:
 * - Fixed training phase (to criterion or max trials)
 * - Adaptive transfer phase (using precomputed lookup tables)
 * - Full data logging for HDP model fitting
 *
 * Setup Instructions:
 * 1. Create a Qualtrics survey with the following structure:
 *    - Q1: Instructions (Text/Graphic)
 *    - Q2: Training Phase (Text/Graphic with JS)
 *    - Q3: Transfer Instructions (Text/Graphic)
 *    - Q4: Transfer Phase (Text/Graphic with JS)
 *    - Q5: Demographics
 *
 * 2. In the Survey Flow, add Embedded Data fields:
 *    - training_data (text, 20000 chars)
 *    - transfer_data (text, 20000 chars)
 *    - alpha_estimate (number)
 *    - training_accuracy (number)
 *    - experiment_complete (number)
 *
 * 3. Add this JavaScript to Q2 and Q4 (training and transfer)
 *
 * 4. Upload your stimulus images to Qualtrics or host externally
 *
 * 5. Upload lookup_tables.json to a public URL or embed in the code
 */

// ============================================================================
// CONFIGURATION - MODIFY THIS SECTION FOR YOUR EXPERIMENT
// ============================================================================

const CONFIG = {
    // Base URL for stimulus images
    // Images should be named by their binary feature string: "0000.png", "0001.png", ..., "1111.png"
    stimulusBaseUrl: "https://andrew-stier.github.io/adaptive_category_learning_qualtrics/stimuli/",
    stimulusExtension: ".png",

    // Feature dimension names (for display/logging only)
    featureNames: ["Size", "Color", "Shape", "Pattern"],

    // Feature value labels (for display/logging only)
    featureValues: {
        0: ["Small", "Blue", "Square", "Plain"],   // When feature = 0
        1: ["Large", "Red", "Round", "Striped"]    // When feature = 1
    },

    // Category labels shown to participants (will be counterbalanced)
    categoryLabels: ["Vekki", "Boula"],  // Neutral nonsense names recommended

    // Key bindings
    keys: {
        categoryA: "f",  // Press F for Category A
        categoryB: "j"   // Press J for Category B
    },

    // Training parameters
    training: {
        trialsPerBlock: 10,
        maxBlocks: 50,                    // Maximum 500 trials
        criterionAccuracy: 0.9,           // 90% accuracy required
        criterionBlocks: 3,               // For 3 consecutive blocks
        feedbackDuration: 1000,           // ms
        itiDuration: 500,                 // Inter-trial interval ms
        stimulusDuration: null,           // null = until response
        maxResponseTime: 5000,            // ms before timeout
    },

    // Transfer parameters
    transfer: {
        totalTrials: 30,                  // Total transfer trials
        feedbackDuration: 0,              // No feedback in transfer
        itiDuration: 500,
        stimulusDuration: null,
        maxResponseTime: 5000,
        adaptiveSelection: true,          // Use adaptive stimulus selection
    },

    // Attention check parameters
    attentionChecks: {
        enabled: true,
        frequency: 20,                    // Every N trials
        question: "Press 'A' to continue",
        correctKey: "a"
    }
};

// ============================================================================
// LOOKUP TABLES - Paste the contents of lookup_tables_minimal.json here
// Or load from external URL
// ============================================================================

// Option 1: Embed lookup tables directly (paste JSON here)
const LOOKUP_TABLES = null;  // Will be loaded from URL if null

// Option 2: Load from external URL
const LOOKUP_TABLES_URL = "https://andrew-stier.github.io/adaptive_category_learning_qualtrics/lookup_tables_minimal.json";

// ============================================================================
// EXPERIMENT STATE
// ============================================================================

const ExperimentState = {
    phase: null,              // "training" or "transfer"
    trialNum: 0,
    blockNum: 0,
    blockTrials: 0,
    blockCorrect: 0,
    consecutiveCriterionBlocks: 0,
    totalCorrect: 0,

    // Trial data
    currentStimulus: null,
    trialStartTime: null,

    // Data storage
    trainingData: [],
    transferData: [],

    // Adaptive transfer state
    alphaBelief: null,        // Current belief distribution over alpha
    alphaValues: null,        // Alpha grid
    shownTransferItems: [],   // Items already shown in transfer

    // Lookup tables
    lookupTables: null,

    // Counterbalancing
    counterbalance: null,     // Stores dimension order, polarity flips, label swap
    participantId: null,      // For seeding counterbalance

    // DOM elements
    container: null,
    stimulusDiv: null,
    feedbackDiv: null,
    progressDiv: null,
};

// ============================================================================
// COUNTERBALANCING
// ============================================================================

/**
 * Seeded random number generator for reproducible counterbalancing.
 * Uses a simple LCG (Linear Congruential Generator).
 */
function seededRandom(seed) {
    let state = seed;
    return function() {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
}

/**
 * Fisher-Yates shuffle with seeded RNG.
 */
function seededShuffle(array, rng) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Generate a numeric seed from a string (participant ID).
 */
function stringToSeed(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;  // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

/**
 * Generate counterbalancing condition for a participant.
 *
 * Returns:
 *   - dimensionOrder: Which physical dimension [0-3] maps to abstract dimension [0-3]
 *   - polarityFlips: Whether to flip 0↔1 for each dimension
 *   - labelSwap: Whether to swap category labels
 *   - conditionCode: Unique identifier for this counterbalance condition
 */
function generateCounterbalance(participantId) {
    const seed = stringToSeed(participantId || Math.random().toString());
    const rng = seededRandom(seed);

    // Shuffle dimension assignment (which physical dim = which abstract dim)
    const dimensionOrder = seededShuffle([0, 1, 2, 3], rng);

    // Randomly flip polarity for each dimension
    const polarityFlips = [
        rng() > 0.5,
        rng() > 0.5,
        rng() > 0.5,
        rng() > 0.5
    ];

    // Randomly swap category labels
    const labelSwap = rng() > 0.5;

    // Create a condition code for logging
    const conditionCode = `D${dimensionOrder.join('')}_P${polarityFlips.map(p => p ? 1 : 0).join('')}_L${labelSwap ? 1 : 0}`;

    return {
        dimensionOrder,
        polarityFlips,
        labelSwap,
        conditionCode,
        seed
    };
}

/**
 * Transform abstract features to physical features based on counterbalancing.
 *
 * Abstract features: The logical feature vector from the category structure [D1, D2, D3, D4]
 * Physical features: What the participant actually sees [Size, Color, Shape, Pattern]
 */
function abstractToPhysical(abstractFeatures, counterbalance) {
    const physical = new Array(4);

    for (let physicalDim = 0; physicalDim < 4; physicalDim++) {
        // Which abstract dimension maps to this physical dimension?
        const abstractDim = counterbalance.dimensionOrder.indexOf(physicalDim);

        // Get the abstract feature value
        let value = abstractFeatures[abstractDim];

        // Apply polarity flip if needed
        if (counterbalance.polarityFlips[physicalDim]) {
            value = 1 - value;
        }

        physical[physicalDim] = value;
    }

    return physical;
}

/**
 * Get the image URL for a stimulus based on its abstract features.
 */
function getImageUrl(abstractFeatures, counterbalance) {
    // Transform to physical features
    const physicalFeatures = abstractToPhysical(abstractFeatures, counterbalance);

    // Create filename from physical features (e.g., "1011.png")
    const filename = physicalFeatures.join('') + CONFIG.stimulusExtension;

    return CONFIG.stimulusBaseUrl + filename;
}

/**
 * Get the displayed category label, accounting for label swap.
 */
function getCategoryLabel(abstractCategory, counterbalance) {
    let displayCategory = abstractCategory;
    if (counterbalance.labelSwap) {
        displayCategory = 1 - displayCategory;
    }
    return CONFIG.categoryLabels[displayCategory];
}

/**
 * Transform participant's response back to abstract category.
 */
function responseToAbstractCategory(responseKey, counterbalance) {
    // responseKey: 0 = left key (first label), 1 = right key (second label)
    let abstractCategory = responseKey;
    if (counterbalance.labelSwap) {
        abstractCategory = 1 - abstractCategory;
    }
    return abstractCategory;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Get the image URL for an item by its ID, using counterbalancing.
 */
function getImageUrlForItem(itemId) {
    // Look up the item's abstract features from the lookup tables
    const allItems = [
        ...(ExperimentState.lookupTables?.training_items || []),
        ...(ExperimentState.lookupTables?.transfer_items || [])
    ];

    const item = allItems.find(t => t.id === itemId);

    if (!item) {
        console.error(`Item not found: ${itemId}`);
        return `https://placeholder.com/300x300?text=${itemId}`;
    }

    // Use counterbalancing to get the correct physical image
    return getImageUrl(item.features, ExperimentState.counterbalance);
}

function logTrial(data) {
    const timestamp = Date.now();

    // Look up the item to get its features
    const allItems = [
        ...(ExperimentState.lookupTables?.training_items || []),
        ...(ExperimentState.lookupTables?.transfer_items || [])
    ];
    const item = allItems.find(t => t.id === data.itemId);

    // Compute physical features (what participant saw) for verification
    let physicalFeatures = null;
    if (item && ExperimentState.counterbalance) {
        physicalFeatures = abstractToPhysical(item.features, ExperimentState.counterbalance);
    }

    const trialRecord = {
        ...data,
        timestamp: timestamp,
        trialNum: ExperimentState.trialNum,
        blockNum: ExperimentState.blockNum,
        abstractFeatures: item?.features,
        physicalFeatures: physicalFeatures,
    };

    if (ExperimentState.phase === "training") {
        ExperimentState.trainingData.push(trialRecord);
    } else {
        ExperimentState.transferData.push(trialRecord);
    }
}

function computeEntropy(probArray) {
    let entropy = 0;
    for (const p of probArray) {
        if (p > 1e-10) {
            entropy -= p * Math.log2(p);
        }
    }
    return entropy;
}

function normalizeArray(arr) {
    const sum = arr.reduce((a, b) => a + b, 0);
    return arr.map(x => x / (sum + 1e-10));
}

// ============================================================================
// ADAPTIVE TRANSFER LOGIC
// ============================================================================

function initializeAlphaBelief() {
    // Start with uniform prior over alpha values
    const n = ExperimentState.alphaValues.length;
    ExperimentState.alphaBelief = new Array(n).fill(1.0 / n);
}

function updateAlphaBelief(itemId, response) {
    // response: 0 = Category A, 1 = Category B
    const tables = ExperimentState.lookupTables;
    const alphaValues = ExperimentState.alphaValues;
    const belief = ExperimentState.alphaBelief;

    // Get P(response=A | alpha) for each alpha
    const pAGivenAlpha = alphaValues.map((alpha, i) => {
        const key = `alpha_${alpha.toFixed(2)}`;
        return tables.response_probabilities[key][itemId] || 0.5;
    });

    // Compute likelihood of observed response
    const likelihood = pAGivenAlpha.map(pA => {
        return response === 0 ? pA : (1 - pA);
    });

    // Bayesian update: posterior ∝ likelihood * prior
    const unnormalizedPosterior = belief.map((b, i) => b * likelihood[i]);
    ExperimentState.alphaBelief = normalizeArray(unnormalizedPosterior);
}

function computeInformationGain(itemId) {
    const tables = ExperimentState.lookupTables;
    const alphaValues = ExperimentState.alphaValues;
    const belief = ExperimentState.alphaBelief;

    // Current entropy
    const hCurrent = computeEntropy(belief);

    // Get P(response=A | alpha) for this item
    const pAGivenAlpha = alphaValues.map((alpha, i) => {
        const key = `alpha_${alpha.toFixed(2)}`;
        return tables.response_probabilities[key][itemId] || 0.5;
    });

    // P(response=A) marginalized over alpha
    const pA = belief.reduce((sum, b, i) => sum + b * pAGivenAlpha[i], 0);
    const pB = 1 - pA;

    // Expected entropy after observing response
    let hExpected = 0;

    // If response = A
    if (pA > 1e-10) {
        const posteriorA = normalizeArray(belief.map((b, i) => b * pAGivenAlpha[i]));
        const hAfterA = computeEntropy(posteriorA);
        hExpected += pA * hAfterA;
    }

    // If response = B
    if (pB > 1e-10) {
        const pBGivenAlpha = pAGivenAlpha.map(p => 1 - p);
        const posteriorB = normalizeArray(belief.map((b, i) => b * pBGivenAlpha[i]));
        const hAfterB = computeEntropy(posteriorB);
        hExpected += pB * hAfterB;
    }

    return hCurrent - hExpected;
}

function selectNextTransferItem() {
    const tables = ExperimentState.lookupTables;
    const shown = new Set(ExperimentState.shownTransferItems);

    // Get all available transfer items
    const available = tables.transfer_items
        .map(item => item.id)
        .filter(id => !shown.has(id));

    if (available.length === 0) {
        // All items shown, repeat from initial ranking
        return tables.initial_ranking[0];
    }

    if (!CONFIG.transfer.adaptiveSelection) {
        // Random selection
        return available[Math.floor(Math.random() * available.length)];
    }

    // Adaptive selection: choose item with highest information gain
    let bestItem = available[0];
    let bestIG = -Infinity;

    for (const itemId of available) {
        const ig = computeInformationGain(itemId);
        if (ig > bestIG) {
            bestIG = ig;
            bestItem = itemId;
        }
    }

    return bestItem;
}

function estimateAlpha() {
    // Return the alpha with highest posterior probability
    const belief = ExperimentState.alphaBelief;
    const alphaValues = ExperimentState.alphaValues;

    let maxIdx = 0;
    let maxProb = belief[0];

    for (let i = 1; i < belief.length; i++) {
        if (belief[i] > maxProb) {
            maxProb = belief[i];
            maxIdx = i;
        }
    }

    // Also compute expected value
    const expectedAlpha = belief.reduce((sum, b, i) => sum + b * alphaValues[i], 0);

    return {
        mapEstimate: alphaValues[maxIdx],
        expectedValue: expectedAlpha,
        posterior: [...belief],
    };
}

// ============================================================================
// TRIAL PRESENTATION
// ============================================================================

function createExperimentHTML() {
    // Get counterbalanced category labels
    const label0 = getCategoryLabel(0, ExperimentState.counterbalance);
    const label1 = getCategoryLabel(1, ExperimentState.counterbalance);

    return `
        <style>
            .exp-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 400px;
                font-family: Arial, sans-serif;
            }
            .stimulus-container {
                width: 300px;
                height: 300px;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 20px 0;
            }
            .stimulus-container img {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }
            .feedback {
                font-size: 24px;
                font-weight: bold;
                height: 40px;
                margin: 10px 0;
            }
            .feedback.correct { color: green; }
            .feedback.incorrect { color: red; }
            .feedback.timeout { color: orange; }
            .progress {
                font-size: 14px;
                color: #666;
                margin-top: 20px;
            }
            .instructions {
                font-size: 18px;
                text-align: center;
                margin-bottom: 20px;
            }
            .key-reminder {
                font-size: 16px;
                color: #444;
                margin-top: 10px;
            }
            .fixation {
                font-size: 48px;
                color: #333;
            }
            .hidden { display: none; }
        </style>
        <div class="exp-container" id="exp-container">
            <div class="instructions" id="instructions">
                Press <strong>${CONFIG.keys.categoryA.toUpperCase()}</strong> for ${label0}<br>
                Press <strong>${CONFIG.keys.categoryB.toUpperCase()}</strong> for ${label1}
            </div>
            <div class="stimulus-container" id="stimulus-container">
                <span class="fixation">+</span>
            </div>
            <div class="feedback" id="feedback"></div>
            <div class="key-reminder">
                <strong>${CONFIG.keys.categoryA.toUpperCase()}</strong> = ${label0} |
                <strong>${CONFIG.keys.categoryB.toUpperCase()}</strong> = ${label1}
            </div>
            <div class="progress" id="progress"></div>
        </div>
    `;
}

function showStimulus(itemId) {
    const stimContainer = document.getElementById("stimulus-container");
    const imageUrl = getImageUrlForItem(itemId);

    stimContainer.innerHTML = `<img src="${imageUrl}" alt="${itemId}" id="stimulus-image">`;
    ExperimentState.trialStartTime = Date.now();
    ExperimentState.currentStimulus = itemId;
}

function showFeedback(correct, timeout = false) {
    const feedbackDiv = document.getElementById("feedback");

    if (timeout) {
        feedbackDiv.textContent = "Too slow!";
        feedbackDiv.className = "feedback timeout";
    } else if (correct) {
        feedbackDiv.textContent = "Correct!";
        feedbackDiv.className = "feedback correct";
    } else {
        feedbackDiv.textContent = "Wrong";
        feedbackDiv.className = "feedback incorrect";
    }
}

function clearFeedback() {
    const feedbackDiv = document.getElementById("feedback");
    feedbackDiv.textContent = "";
    feedbackDiv.className = "feedback";
}

function showFixation() {
    const stimContainer = document.getElementById("stimulus-container");
    stimContainer.innerHTML = '<span class="fixation">+</span>';
}

function updateProgress() {
    const progressDiv = document.getElementById("progress");

    if (ExperimentState.phase === "training") {
        const accuracy = ExperimentState.blockTrials > 0
            ? (ExperimentState.blockCorrect / ExperimentState.blockTrials * 100).toFixed(0)
            : 0;
        progressDiv.textContent = `Block ${ExperimentState.blockNum + 1} | Trial ${ExperimentState.blockTrials}/${CONFIG.training.trialsPerBlock} | Accuracy: ${accuracy}%`;
    } else {
        progressDiv.textContent = `Transfer Trial ${ExperimentState.trialNum + 1}/${CONFIG.transfer.totalTrials}`;
    }
}

// ============================================================================
// TRAINING PHASE
// ============================================================================

function getTrainingTrialSequence() {
    // Create a block of trials with each training item appearing once
    const trainingIds = ExperimentState.lookupTables.training_items.map(item => item.id);
    return shuffleArray(trainingIds);
}

function runTrainingTrial() {
    // Check if block is complete
    if (ExperimentState.blockTrials >= CONFIG.training.trialsPerBlock) {
        endTrainingBlock();
        return;
    }

    // Get next stimulus
    if (!ExperimentState.currentBlockSequence || ExperimentState.currentBlockSequence.length === 0) {
        ExperimentState.currentBlockSequence = getTrainingTrialSequence();
    }

    const itemId = ExperimentState.currentBlockSequence.shift();
    const item = ExperimentState.lookupTables.training_items.find(t => t.id === itemId);

    // Show stimulus and wait for response
    showStimulus(itemId);
    updateProgress();

    // Set up response handler
    ExperimentState.responseHandler = (response, rt) => {
        handleTrainingResponse(itemId, item.category, response, rt);
    };

    // Set up timeout
    ExperimentState.timeoutId = setTimeout(() => {
        handleTrainingResponse(itemId, item.category, -1, CONFIG.training.maxResponseTime);
    }, CONFIG.training.maxResponseTime);
}

function handleTrainingResponse(itemId, correctCategory, response, rt) {
    // Clear timeout
    if (ExperimentState.timeoutId) {
        clearTimeout(ExperimentState.timeoutId);
        ExperimentState.timeoutId = null;
    }

    const correct = response === correctCategory;
    const timeout = response === -1;

    // Update counters
    ExperimentState.blockTrials++;
    ExperimentState.trialNum++;
    if (correct) {
        ExperimentState.blockCorrect++;
        ExperimentState.totalCorrect++;
    }

    // Log trial
    logTrial({
        phase: "training",
        itemId: itemId,
        correctCategory: correctCategory,
        response: response,
        correct: correct,
        timeout: timeout,
        rt: rt,
    });

    // Show feedback
    showFeedback(correct, timeout);

    // Continue to next trial after feedback
    setTimeout(() => {
        clearFeedback();
        showFixation();
        setTimeout(runTrainingTrial, CONFIG.training.itiDuration);
    }, CONFIG.training.feedbackDuration);
}

function endTrainingBlock() {
    const accuracy = ExperimentState.blockCorrect / CONFIG.training.trialsPerBlock;

    // Check criterion
    if (accuracy >= CONFIG.training.criterionAccuracy) {
        ExperimentState.consecutiveCriterionBlocks++;
    } else {
        ExperimentState.consecutiveCriterionBlocks = 0;
    }

    // Check if training is complete
    if (ExperimentState.consecutiveCriterionBlocks >= CONFIG.training.criterionBlocks) {
        endTrainingPhase("criterion");
        return;
    }

    if (ExperimentState.blockNum >= CONFIG.training.maxBlocks - 1) {
        endTrainingPhase("max_blocks");
        return;
    }

    // Start next block
    ExperimentState.blockNum++;
    ExperimentState.blockTrials = 0;
    ExperimentState.blockCorrect = 0;
    ExperimentState.currentBlockSequence = null;

    runTrainingTrial();
}

function endTrainingPhase(reason) {
    const finalAccuracy = ExperimentState.totalCorrect / ExperimentState.trialNum;

    console.log(`Training complete: ${reason}, accuracy: ${(finalAccuracy * 100).toFixed(1)}%`);

    // Save training data to Qualtrics
    saveTrainingData(finalAccuracy, reason);

    // Signal completion to Qualtrics
    if (typeof Qualtrics !== 'undefined') {
        Qualtrics.SurveyEngine.setEmbeddedData('training_accuracy', finalAccuracy);
        document.getElementById('NextButton').click();
    }
}

// ============================================================================
// TRANSFER PHASE
// ============================================================================

function runTransferTrial() {
    if (ExperimentState.trialNum >= CONFIG.transfer.totalTrials) {
        endTransferPhase();
        return;
    }

    // Select next item adaptively
    const itemId = selectNextTransferItem();
    ExperimentState.shownTransferItems.push(itemId);

    // Show stimulus
    showStimulus(itemId);
    updateProgress();

    // Set up response handler
    ExperimentState.responseHandler = (response, rt) => {
        handleTransferResponse(itemId, response, rt);
    };

    // Set up timeout
    ExperimentState.timeoutId = setTimeout(() => {
        handleTransferResponse(itemId, -1, CONFIG.transfer.maxResponseTime);
    }, CONFIG.transfer.maxResponseTime);
}

function handleTransferResponse(itemId, response, rt) {
    // Clear timeout
    if (ExperimentState.timeoutId) {
        clearTimeout(ExperimentState.timeoutId);
        ExperimentState.timeoutId = null;
    }

    const timeout = response === -1;

    // Update alpha belief if valid response
    if (!timeout) {
        updateAlphaBelief(itemId, response);
    }

    // Get item metadata
    const item = ExperimentState.lookupTables.transfer_items.find(t => t.id === itemId);

    // Log trial with full information
    logTrial({
        phase: "transfer",
        itemId: itemId,
        features: item?.features,
        itemType: item?.item_type,
        diagnosticType: item?.diagnostic_type,
        response: response,
        timeout: timeout,
        rt: rt,
        alphaBelief: [...ExperimentState.alphaBelief],
        informationGain: computeInformationGain(itemId),
    });

    ExperimentState.trialNum++;

    // Continue to next trial (no feedback in transfer)
    showFixation();
    setTimeout(runTransferTrial, CONFIG.transfer.itiDuration);
}

function endTransferPhase() {
    const alphaEstimate = estimateAlpha();

    console.log(`Transfer complete. Alpha estimate: ${alphaEstimate.expectedValue.toFixed(2)}`);

    // Save transfer data to Qualtrics
    saveTransferData(alphaEstimate);

    // Signal completion
    if (typeof Qualtrics !== 'undefined') {
        Qualtrics.SurveyEngine.setEmbeddedData('alpha_estimate', alphaEstimate.expectedValue);
        Qualtrics.SurveyEngine.setEmbeddedData('experiment_complete', 1);
        document.getElementById('NextButton').click();
    }
}

// ============================================================================
// DATA SAVING
// ============================================================================

function saveTrainingData(accuracy, reason) {
    const data = {
        participantId: ExperimentState.participantId,
        counterbalance: ExperimentState.counterbalance,
        trials: ExperimentState.trainingData,
        summary: {
            totalTrials: ExperimentState.trialNum,
            totalBlocks: ExperimentState.blockNum + 1,
            finalAccuracy: accuracy,
            completionReason: reason,
        }
    };

    const jsonString = JSON.stringify(data);

    if (typeof Qualtrics !== 'undefined') {
        Qualtrics.SurveyEngine.setEmbeddedData('training_data', jsonString);
        Qualtrics.SurveyEngine.setEmbeddedData('counterbalance_condition', ExperimentState.counterbalance.conditionCode);
    }

    // Also log to console for debugging
    console.log("Training data:", data);
}

function saveTransferData(alphaEstimate) {
    const data = {
        participantId: ExperimentState.participantId,
        counterbalance: ExperimentState.counterbalance,
        trials: ExperimentState.transferData,
        alphaEstimate: alphaEstimate,
        alphaValues: ExperimentState.alphaValues,
        finalBelief: ExperimentState.alphaBelief,
    };

    const jsonString = JSON.stringify(data);

    if (typeof Qualtrics !== 'undefined') {
        Qualtrics.SurveyEngine.setEmbeddedData('transfer_data', jsonString);
    }

    console.log("Transfer data:", data);
}

// ============================================================================
// KEY HANDLING
// ============================================================================

function setupKeyHandler() {
    document.addEventListener('keydown', function(event) {
        if (!ExperimentState.responseHandler) return;

        const key = event.key.toLowerCase();
        const rt = Date.now() - ExperimentState.trialStartTime;

        let response = null;

        if (key === CONFIG.keys.categoryA) {
            response = 0;  // Category A
        } else if (key === CONFIG.keys.categoryB) {
            response = 1;  // Category B
        }

        if (response !== null) {
            const handler = ExperimentState.responseHandler;
            ExperimentState.responseHandler = null;  // Prevent double responses
            handler(response, rt);
        }
    });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function loadLookupTables() {
    if (LOOKUP_TABLES) {
        return LOOKUP_TABLES;
    }

    try {
        const response = await fetch(LOOKUP_TABLES_URL);
        return await response.json();
    } catch (error) {
        console.error("Failed to load lookup tables:", error);
        throw error;
    }
}

async function initializeExperiment(phase) {
    console.log(`Initializing ${phase} phase...`);

    // Load lookup tables
    ExperimentState.lookupTables = await loadLookupTables();
    ExperimentState.alphaValues = ExperimentState.lookupTables.alpha_values;

    // Get or generate participant ID for counterbalancing
    if (!ExperimentState.participantId) {
        // Try to get from Qualtrics embedded data, URL param, or generate random
        if (typeof Qualtrics !== 'undefined') {
            ExperimentState.participantId = Qualtrics.SurveyEngine.getEmbeddedData('ResponseId') ||
                                            Qualtrics.SurveyEngine.getEmbeddedData('participantId') ||
                                            'P' + Date.now();
        } else {
            // Check URL params
            const urlParams = new URLSearchParams(window.location.search);
            ExperimentState.participantId = urlParams.get('PROLIFIC_PID') ||
                                            urlParams.get('participantId') ||
                                            'P' + Date.now();
        }
    }

    // Generate counterbalancing (only once, on training phase)
    if (phase === "training" || !ExperimentState.counterbalance) {
        ExperimentState.counterbalance = generateCounterbalance(ExperimentState.participantId);
        console.log("Counterbalance condition:", ExperimentState.counterbalance.conditionCode);
    }

    // Set phase
    ExperimentState.phase = phase;
    ExperimentState.trialNum = 0;

    if (phase === "transfer") {
        initializeAlphaBelief();
    }

    // Create experiment HTML
    const container = document.querySelector('.QuestionBody') || document.body;
    container.innerHTML = createExperimentHTML();

    // Set up key handler
    setupKeyHandler();

    // Hide Qualtrics next button during experiment
    if (typeof Qualtrics !== 'undefined') {
        document.getElementById('NextButton').style.display = 'none';
    }

    // Start first trial
    setTimeout(() => {
        if (phase === "training") {
            runTrainingTrial();
        } else {
            runTransferTrial();
        }
    }, 1000);
}

// ============================================================================
// QUALTRICS INTEGRATION
// ============================================================================

// This function should be called from Qualtrics question JavaScript
// For Training question: initCategoryLearning("training")
// For Transfer question: initCategoryLearning("transfer")

function initCategoryLearning(phase) {
    if (typeof Qualtrics !== 'undefined') {
        Qualtrics.SurveyEngine.addOnload(function() {
            initializeExperiment(phase);
        });
    } else {
        // Running outside Qualtrics (for testing)
        document.addEventListener('DOMContentLoaded', () => {
            initializeExperiment(phase);
        });
    }
}

// Export for use in Qualtrics
if (typeof window !== 'undefined') {
    window.initCategoryLearning = initCategoryLearning;
    window.CONFIG = CONFIG;
    window.ExperimentState = ExperimentState;
}
