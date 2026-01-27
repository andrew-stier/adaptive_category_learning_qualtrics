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
    featureNames: ["Body", "Antenna", "Eyes", "Pattern"],

    // Feature value labels (for display/logging only)
    featureValues: {
        0: ["Round", "Single", "One", "Solid"],    // When feature = 0
        1: ["Tall", "Double", "Two", "Spotted"]    // When feature = 1
    },

    // Category labels shown to participants (will be counterbalanced)
    categoryLabels: ["Vekki", "Boula"],  // Neutral nonsense names recommended

    // Key bindings
    keys: {
        categoryA: "e",  // Press E for Category A
        categoryB: "i"   // Press I for Category B
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
        breakBetweenBlocks: true,         // Show break screen between blocks
        adaptiveSelection: false,         // Use random stimulus selection for training
        warmupBlocks: 3,                  // Random selection for first N blocks before adaptive kicks in
    },

    // Transfer parameters
    transfer: {
        totalTrials: 64,                  // Total transfer trials
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
    if (!probArray || probArray.length === 0) {
        return 0;
    }
    let entropy = 0;
    for (const p of probArray) {
        if (p > 1e-10) {
            entropy -= p * Math.log2(p);
        }
    }
    return entropy;
}

function normalizeArray(arr) {
    if (!arr || arr.length === 0) {
        return [];
    }
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

    // Guard against uninitialized state
    if (!belief || !alphaValues || !tables || !tables.response_probabilities) {
        console.warn('[CategoryLearning] updateAlphaBelief called with uninitialized state');
        return;
    }

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

    // Guard against uninitialized state
    if (!belief || !alphaValues || !tables || !tables.response_probabilities) {
        console.warn('[CategoryLearning] computeInformationGain called with uninitialized state');
        return 0;
    }

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

    // Get all transfer items
    const allItems = tables.transfer_items.map(item => item.id);

    if (!CONFIG.transfer.adaptiveSelection) {
        // Random selection without replacement until all shown, then reset
        let available = allItems.filter(id => !shown.has(id));
        if (available.length === 0) {
            console.log('[CategoryLearning] All transfer items shown, resetting');
            ExperimentState.shownTransferItems = [];
            available = allItems;
        }
        return available[Math.floor(Math.random() * available.length)];
    }

    // Adaptive selection: choose item with highest information gain
    // Allow any item to be selected, but track presentation counts
    const presentationCounts = {};
    for (const id of allItems) {
        presentationCounts[id] = ExperimentState.transferData.filter(t => t.itemId === id).length;
    }

    // Find max presentations to ensure some balance (no item shown more than 2x the minimum)
    const minCount = Math.min(...Object.values(presentationCounts));
    const maxAllowed = minCount + 3; // Allow up to 3 more presentations than the least-shown item

    // Filter items that haven't exceeded max presentations
    let available = allItems.filter(id => presentationCounts[id] < maxAllowed);
    if (available.length === 0) {
        available = allItems; // Fallback if all maxed out
    }

    // Prevent back-to-back repetition: exclude the last shown item
    const lastItem = ExperimentState.lastTransferItem;
    if (lastItem && available.length > 1) {
        available = available.filter(id => id !== lastItem);
    }

    let bestItem = available[0];
    let bestIG = -Infinity;

    for (const itemId of available) {
        const ig = computeInformationGain(itemId);
        if (ig > bestIG) {
            bestIG = ig;
            bestItem = itemId;
        }
    }

    ExperimentState.lastTransferItem = bestItem;
    const count = presentationCounts[bestItem] + 1;
    console.log(`[CategoryLearning] Selected ${bestItem} (presentation #${count}) with info gain ${bestIG.toFixed(6)}`);
    return bestItem;
}

function estimateAlpha() {
    // Return the alpha with highest posterior probability
    const belief = ExperimentState.alphaBelief;
    const alphaValues = ExperimentState.alphaValues;

    // Guard against uninitialized state
    if (!belief || !alphaValues || belief.length === 0) {
        console.warn('[CategoryLearning] estimateAlpha called with uninitialized belief');
        return {
            mapEstimate: null,
            expectedValue: null,
            posterior: [],
        };
    }

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
            body, html {
                background-color: #F5F5F5 !important;
            }
            .exp-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 400px;
                font-family: Arial, sans-serif;
                background-color: #F5F5F5;
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
            .key-reminder {
                display: flex;
                justify-content: space-between;
                width: 100%;
                max-width: 400px;
                font-size: 16px;
                color: #444;
                margin-top: 10px;
            }
            .key-left {
                text-align: left;
            }
            .key-right {
                text-align: right;
            }
            .fixation {
                font-size: 48px;
                color: #333;
            }
            .start-screen {
                text-align: center;
            }
            .start-screen .fixation {
                margin-bottom: 30px;
            }
            .start-prompt {
                font-size: 18px;
                color: #666;
            }
            .hidden { display: none; }
        </style>
        <div class="exp-container" id="exp-container">
            <div class="start-screen" id="start-screen">
                <span class="fixation">+</span>
                <div class="start-prompt">Press <strong>SPACEBAR</strong> to begin</div>
            </div>
            <div class="stimulus-container" id="stimulus-container" style="display: none;">
            </div>
            <div class="feedback" id="feedback"></div>
            <div class="key-reminder" id="key-reminder" style="display: none;">
                <span class="key-left">Press <strong>${CONFIG.keys.categoryA.toUpperCase()}</strong> = ${label0}</span>
                <span class="key-right">Press <strong>${CONFIG.keys.categoryB.toUpperCase()}</strong> = ${label1}</span>
            </div>
        </div>
    `;
}

function showStimulus(itemId) {
    const stimContainer = document.getElementById("stimulus-container");
    const imageUrl = getImageUrlForItem(itemId);

    if (stimContainer) {
        stimContainer.innerHTML = `<img src="${imageUrl}" alt="${itemId}" id="stimulus-image">`;
    }
    ExperimentState.trialStartTime = Date.now();
    ExperimentState.currentStimulus = itemId;
}

function showFeedback(correct, timeout = false) {
    const feedbackDiv = document.getElementById("feedback");
    if (!feedbackDiv) return;

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
    if (feedbackDiv) {
        feedbackDiv.textContent = "";
        feedbackDiv.className = "feedback";
    }
}

function showFixation() {
    const stimContainer = document.getElementById("stimulus-container");
    if (stimContainer) {
        stimContainer.style.display = 'flex';
        stimContainer.innerHTML = '<span class="fixation">+</span>';
    }
    const feedbackDiv = document.getElementById("feedback");
    if (feedbackDiv) {
        feedbackDiv.textContent = '';
    }
}

function updateProgress() {
    // Progress display removed per design - keep function for compatibility
}

// ============================================================================
// TRAINING PHASE
// ============================================================================

function getTrainingTrialSequence() {
    // Create a block of trials with each training item appearing once (random order)
    const trainingIds = ExperimentState.lookupTables.training_items.map(item => item.id);
    return shuffleArray(trainingIds);
}

function selectNextTrainingItem() {
    // Select next training item - random during warmup, adaptive after
    const tables = ExperimentState.lookupTables;
    const allItems = tables.training_items.map(item => item.id);

    // Check if still in warmup period (blockNum is 0-indexed, so warmupBlocks=3 means blocks 0,1,2 are warmup)
    const currentBlock = ExperimentState.blockNum;
    const useAdaptive = CONFIG.training.adaptiveSelection && currentBlock >= CONFIG.training.warmupBlocks;

    if (!useAdaptive) {
        // Random selection from current block sequence
        if (!ExperimentState.currentBlockSequence || ExperimentState.currentBlockSequence.length === 0) {
            ExperimentState.currentBlockSequence = getTrainingTrialSequence();
        }
        return ExperimentState.currentBlockSequence.shift();
    }

    // Adaptive selection: choose item with highest information gain
    // Track how many times each item has been shown this block
    if (!ExperimentState.blockItemCounts) {
        ExperimentState.blockItemCounts = {};
    }

    // Count presentations this block
    const blockCounts = ExperimentState.blockItemCounts;
    for (const id of allItems) {
        if (blockCounts[id] === undefined) blockCounts[id] = 0;
    }

    // Ensure some balance within block (no item more than 2 ahead of others)
    const minCount = Math.min(...Object.values(blockCounts));
    const maxAllowed = minCount + 2;

    let available = allItems.filter(id => blockCounts[id] < maxAllowed);
    if (available.length === 0) {
        available = allItems;
    }

    // Prevent back-to-back repetition: exclude the last shown item
    const lastItem = ExperimentState.lastTrainingItem;
    if (lastItem && available.length > 1) {
        available = available.filter(id => id !== lastItem);
    }

    // Select based on information gain
    let bestItem = available[0];
    let bestIG = -Infinity;

    for (const itemId of available) {
        const ig = computeInformationGain(itemId);
        if (ig > bestIG) {
            bestIG = ig;
            bestItem = itemId;
        }
    }

    blockCounts[bestItem]++;
    ExperimentState.lastTrainingItem = bestItem;
    console.log(`[CategoryLearning] Adaptive training: selected ${bestItem} with info gain ${bestIG.toFixed(6)}`);
    return bestItem;
}

function runTrainingTrial() {
    console.log('[CategoryLearning] Running training trial', ExperimentState.trialNum + 1);

    // Check if block is complete
    if (ExperimentState.blockTrials >= CONFIG.training.trialsPerBlock) {
        endTrainingBlock();
        return;
    }

    // Get next stimulus (random or adaptive depending on warmup)
    const itemId = selectNextTrainingItem();
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

    // Update alpha belief for adaptive selection (if enabled and not timeout)
    if (CONFIG.training.adaptiveSelection && !timeout && ExperimentState.alphaBelief) {
        updateAlphaBelief(itemId, response);
    }

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

    console.log(`[CategoryLearning] Block ${ExperimentState.blockNum + 1} complete, accuracy: ${(accuracy * 100).toFixed(0)}%`);

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
    ExperimentState.blockItemCounts = {}; // Reset for adaptive selection

    // Log when adaptive selection kicks in
    if (CONFIG.training.adaptiveSelection && ExperimentState.blockNum === CONFIG.training.warmupBlocks) {
        console.log(`[CategoryLearning] Warmup complete - switching to adaptive stimulus selection`);
    }

    // Show break screen or continue immediately
    if (CONFIG.training.breakBetweenBlocks) {
        showBlockBreak();
    } else {
        runTrainingTrial();
    }
}

function showBlockBreak() {
    console.log('[CategoryLearning] Showing block break');
    const stimContainer = document.getElementById('stimulus-container');
    const keyReminder = document.getElementById('key-reminder');
    const feedbackDiv = document.getElementById('feedback');
    const startScreen = document.getElementById('start-screen');

    if (stimContainer) stimContainer.style.display = 'none';
    if (keyReminder) keyReminder.style.display = 'none';
    if (feedbackDiv) feedbackDiv.textContent = '';

    // Re-use start screen for break
    if (startScreen) {
        startScreen.innerHTML = `
            <span class="fixation">+</span>
            <div class="start-prompt">Take a short break<br><br>Press <strong>SPACEBAR</strong> to continue</div>
        `;
        startScreen.style.display = 'block';
    }
    ExperimentState.waitingForStart = true;
}

function endTrainingPhase(reason) {
    const finalAccuracy = ExperimentState.trialNum > 0
        ? ExperimentState.totalCorrect / ExperimentState.trialNum
        : 0;

    console.log(`[CategoryLearning] Training complete: ${reason}, accuracy: ${(finalAccuracy * 100).toFixed(1)}%`);

    // Save training data to Qualtrics
    saveTrainingData(finalAccuracy, reason);

    // Signal completion to Qualtrics
    if (typeof Qualtrics !== 'undefined') {
        Qualtrics.SurveyEngine.setEmbeddedData('training_accuracy', finalAccuracy);
    }

    // Click next button - use bound proceed function (like MinnoJS working code)
    setTimeout(function() {
        if (typeof ExperimentState.proceedToNextPage === 'function') {
            console.log('[CategoryLearning] Training complete, using bound proceedToNextPage()');
            ExperimentState.proceedToNextPage();
        } else if (ExperimentState.questionContext && typeof ExperimentState.questionContext.clickNextButton === 'function') {
            console.log('[CategoryLearning] Training complete, using questionContext.clickNextButton()');
            ExperimentState.questionContext.clickNextButton();
        } else {
            console.log('[CategoryLearning] Training complete, clicking NextButton by ID');
            var nextBtn = document.getElementById('NextButton');
            if (nextBtn) nextBtn.click();
        }
    }, 100);
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

    console.log(`[CategoryLearning] Transfer complete. Alpha estimate: ${alphaEstimate.expectedValue.toFixed(2)}`);

    // Save transfer data to Qualtrics
    saveTransferData(alphaEstimate);

    // Signal completion
    if (typeof Qualtrics !== 'undefined') {
        Qualtrics.SurveyEngine.setEmbeddedData('alpha_estimate', alphaEstimate.expectedValue);
        Qualtrics.SurveyEngine.setEmbeddedData('experiment_complete', 1);
    }

    // Show completion message
    const container = ExperimentState.containerElement || document.getElementById('exp-container');
    if (container) {
        container.innerHTML = '<div style="text-align:center;padding:50px;font-family:Arial,sans-serif;"><h2>Transfer phase complete!</h2><p>Please wait...</p></div>';
    }

    // Click next button - use bound proceed function (like MinnoJS working code)
    setTimeout(function() {
        console.log('[CategoryLearning] Attempting to advance to next page...');

        // Method 1: Use bound proceed function (most reliable)
        if (typeof ExperimentState.proceedToNextPage === 'function') {
            console.log('[CategoryLearning] Using bound proceedToNextPage()');
            ExperimentState.proceedToNextPage();
            return;
        }

        // Method 2: Try questionContext.clickNextButton
        if (ExperimentState.questionContext && typeof ExperimentState.questionContext.clickNextButton === 'function') {
            console.log('[CategoryLearning] Using questionContext.clickNextButton()');
            ExperimentState.questionContext.clickNextButton();
            return;
        }

        // Method 3: Try NextButton by ID
        var nextBtn = document.getElementById('NextButton');
        if (nextBtn) {
            console.log('[CategoryLearning] Clicking NextButton by ID');
            nextBtn.click();
            return;
        }

        // Fallback: show manual instructions
        console.log('[CategoryLearning] Could not find next button - showing manual instructions');
        if (container) {
            container.innerHTML = '<div style="text-align:center;padding:50px;font-family:Arial,sans-serif;"><h2>Transfer phase complete!</h2><p>Click the Next button below to continue.</p></div>';
        }
        // Force-show any hidden next buttons
        var allNextButtons = document.querySelectorAll('[id*="Next"], [class*="Next"], input[type="submit"]');
        allNextButtons.forEach(function(btn) {
            btn.style.display = 'inline-block';
            btn.style.visibility = 'visible';
        });
    }, 100);
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
    // Prevent duplicate handlers
    if (ExperimentState.keyHandlerSetup) {
        return;
    }
    ExperimentState.keyHandlerSetup = true;

    document.addEventListener('keydown', function(event) {
        const key = event.key.toLowerCase();

        // DEBUG SHORTCUT: Shift+Alt+Enter to skip remaining trials
        if (event.shiftKey && event.altKey && event.key === 'Enter') {
            event.preventDefault();
            console.log('[CategoryLearning] DEBUG: Skipping remaining trials');
            ExperimentState.responseHandler = null;
            // Clear any pending timeout
            if (ExperimentState.timeoutId) {
                clearTimeout(ExperimentState.timeoutId);
                ExperimentState.timeoutId = null;
            }
            if (ExperimentState.phase === 'training') {
                endTrainingPhase('debug_skip');
            } else if (ExperimentState.phase === 'transfer') {
                endTransferPhase();
            }
            return;
        }

        // Handle spacebar for start/continue screens
        if (key === ' ' || event.code === 'Space') {
            event.preventDefault();
            if (ExperimentState.waitingForStart) {
                ExperimentState.waitingForStart = false;
                startTrials();
                return;
            }
        }

        // Handle category responses
        if (!ExperimentState.responseHandler) return;

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

function showStartScreen() {
    console.log('[CategoryLearning] Showing start screen');
    const startScreen = document.getElementById('start-screen');
    const stimContainer = document.getElementById('stimulus-container');
    const keyReminder = document.getElementById('key-reminder');
    const feedbackDiv = document.getElementById('feedback');

    if (startScreen) startScreen.style.display = 'block';
    if (stimContainer) stimContainer.style.display = 'none';
    if (keyReminder) keyReminder.style.display = 'none';
    if (feedbackDiv) feedbackDiv.textContent = '';
    ExperimentState.waitingForStart = true;
}

function startTrials() {
    console.log('[CategoryLearning] Starting trials');
    const startScreen = document.getElementById('start-screen');
    const stimContainer = document.getElementById('stimulus-container');
    const keyReminder = document.getElementById('key-reminder');

    if (startScreen) startScreen.style.display = 'none';
    if (stimContainer) stimContainer.style.display = 'flex';
    if (keyReminder) keyReminder.style.display = 'flex';

    // Show fixation cross first, then start trial
    showFixation();
    setTimeout(() => {
        if (ExperimentState.phase === "training") {
            runTrainingTrial();
        } else {
            runTransferTrial();
        }
    }, CONFIG.training.itiDuration);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function loadLookupTables() {
    console.log('[CategoryLearning] Loading lookup tables...');

    if (LOOKUP_TABLES) {
        console.log('[CategoryLearning] Using embedded lookup tables');
        return LOOKUP_TABLES;
    }

    console.log('[CategoryLearning] Fetching from:', LOOKUP_TABLES_URL);
    try {
        const response = await fetch(LOOKUP_TABLES_URL);
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }
        const tables = await response.json();
        console.log('[CategoryLearning] Lookup tables loaded successfully');
        return tables;
    } catch (error) {
        console.error("[CategoryLearning] Failed to load lookup tables:", error);
        throw new Error("Failed to load experiment data: " + error.message);
    }
}

async function initializeExperiment(phase) {
    console.log(`[CategoryLearning] Initializing ${phase} phase...`);

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
        console.log("[CategoryLearning] Counterbalance condition:", ExperimentState.counterbalance.conditionCode);
    }

    // Set phase
    ExperimentState.phase = phase;
    ExperimentState.trialNum = 0;

    // Reset phase-specific state
    if (phase === "transfer") {
        ExperimentState.shownTransferItems = [];
        ExperimentState.transferData = [];
        ExperimentState.lastTransferItem = null;
    } else if (phase === "training") {
        ExperimentState.trainingData = [];
        ExperimentState.blockNum = 0;
        ExperimentState.blockTrials = 0;
        ExperimentState.blockCorrect = 0;
        ExperimentState.consecutiveCriterionBlocks = 0;
        ExperimentState.totalCorrect = 0;
        ExperimentState.currentBlockSequence = null;
        ExperimentState.blockItemCounts = {};
        ExperimentState.lastTrainingItem = null;
    }

    // Initialize alpha belief for adaptive selection (needed for both training and transfer)
    if (phase === "transfer" || (phase === "training" && CONFIG.training.adaptiveSelection)) {
        initializeAlphaBelief();
    }

    // Create experiment HTML in the appropriate container
    const container = ExperimentState.containerElement ||
                      document.querySelector('.QuestionBody') ||
                      document.querySelector('#category-learning-container') ||
                      document.body;
    console.log('[CategoryLearning] Using container:', container);
    const html = createExperimentHTML();
    console.log('[CategoryLearning] Created HTML, length:', html.length);
    container.innerHTML = html;
    console.log('[CategoryLearning] Experiment HTML inserted into DOM');

    // Set up key handler
    setupKeyHandler();

    // Hide Qualtrics next button during experiment
    // Use the question context method if available, otherwise try direct DOM
    if (ExperimentState.questionContext && typeof ExperimentState.questionContext.hideNextButton === 'function') {
        ExperimentState.questionContext.hideNextButton();
        console.log('[CategoryLearning] Hid next button via questionContext');
    } else {
        var nextBtn = document.getElementById('NextButton');
        if (nextBtn) {
            nextBtn.style.display = 'none';
            console.log('[CategoryLearning] Hid next button via DOM');
        }
    }

    // Show start screen and wait for spacebar
    showStartScreen();
}

// ============================================================================
// QUALTRICS INTEGRATION
// ============================================================================

// This function should be called from Qualtrics question JavaScript
// For Training question: initCategoryLearning("training", questionContext)
// For Transfer question: initCategoryLearning("transfer", questionContext)

function initCategoryLearning(phase, questionContext) {
    console.log(`[CategoryLearning] Initializing ${phase} phase...`);

    // Prevent double initialization
    if (ExperimentState.initializingPhase === phase) {
        console.log(`[CategoryLearning] Already initializing ${phase}, skipping duplicate call`);
        return;
    }
    ExperimentState.initializingPhase = phase;

    // Store question context and bound proceed function for later use
    // Only update if we have a valid context (don't overwrite with null)
    if (questionContext) {
        ExperimentState.questionContext = questionContext;
        // Store bound function like working MinnoJS code does
        if (typeof questionContext.clickNextButton === 'function') {
            ExperimentState.proceedToNextPage = questionContext.clickNextButton.bind(questionContext);
        }
    }

    // If we have a Qualtrics question context, set up the container properly
    if (questionContext && typeof questionContext.getQuestionContainer === 'function') {
        const container = questionContext.getQuestionContainer();
        console.log('[CategoryLearning] Got question container:', container);

        // Set background color to match stimulus images
        const bgColor = '#F5F5F5';
        container.style.backgroundColor = bgColor;
        if (typeof jQuery !== 'undefined') {
            jQuery('.SkinInner').css('background-color', bgColor);
            jQuery('.Skin').css('background-color', bgColor);
            jQuery('body').css('background-color', bgColor);
        }
        document.body.style.backgroundColor = bgColor;

        // Hide the default question content
        const inner = container.querySelector('.Inner');
        if (inner) {
            inner.style.display = 'none';
            console.log('[CategoryLearning] Hid .Inner element');
        }

        // Create a div for our experiment
        let expDiv = container.querySelector('#category-learning-container');
        if (!expDiv) {
            expDiv = document.createElement('div');
            expDiv.id = 'category-learning-container';
            expDiv.style.width = '100%';
            expDiv.style.minHeight = '400px';
            expDiv.style.backgroundColor = bgColor;
            container.appendChild(expDiv);
            console.log('[CategoryLearning] Created experiment container div');
        }

        // Store reference to our container
        ExperimentState.containerElement = expDiv;

        console.log('[CategoryLearning] Container set up in Qualtrics');
    } else {
        console.log('[CategoryLearning] No Qualtrics context, using document body');
        ExperimentState.containerElement = document.body;
    }

    // Show a loading message while we initialize
    if (ExperimentState.containerElement) {
        ExperimentState.containerElement.innerHTML = '<div style="text-align:center;padding:50px;font-family:Arial,sans-serif;"><p>Loading experiment...</p></div>';
    }

    // Now initialize the experiment (async) with proper error handling
    initializeExperiment(phase).catch(function(error) {
        console.error('[CategoryLearning] Initialization error:', error);
        // Clear initializing flag to allow retry
        ExperimentState.initializingPhase = null;
        var errorMsg = '<div style="text-align:center;padding:50px;font-family:Arial,sans-serif;color:red;">' +
                       '<h3>Error Loading Experiment</h3>' +
                       '<p>' + error.message + '</p>' +
                       '<p>Please refresh the page or contact the researcher.</p></div>';
        if (ExperimentState.containerElement) {
            ExperimentState.containerElement.innerHTML = errorMsg;
        } else {
            document.body.innerHTML = errorMsg;
        }
    });
}

// Export for use in Qualtrics
if (typeof window !== 'undefined') {
    window.initCategoryLearning = initCategoryLearning;
    window.CONFIG = CONFIG;
    window.ExperimentState = ExperimentState;
}
