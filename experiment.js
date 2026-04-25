// ============================================================================
// CONFIGURATION - MODIFY THIS SECTION FOR YOUR EXPERIMENT
// ============================================================================

const CONFIG = {
    // Base URL for stimulus images
    // Images should be named by their binary feature string: "00000.png", "00001.png", ..., "11111.png"
    stimulusBaseUrl: "https://andrew-stier.github.io/adaptive_category_learning_qualtrics/stimuli/",
    stimulusExtension: ".png",

    // Feature dimension names (for display/logging only) - 5 dimensions
    featureNames: ["Body", "Antenna", "Eyes", "Pattern", "Tail"],

    // Feature value labels (for display/logging only) - 5 dimensions
    featureValues: {
        0: ["Round", "Single", "One", "Solid", "None"],      // When feature = 0
        1: ["Tall", "Double", "Two", "Spotted", "Tail"]      // When feature = 1
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
        maxBlocks: 40,                    // Maximum 400 trials
        criterionAccuracy: 0.9,           // 90% accuracy required
        criterionBlocks: 3,               // For 3 consecutive blocks
        feedbackDuration: 1000,           // ms
        itiDuration: 500,                 // Inter-trial interval ms
        timeoutExtraITI: 1000,            // Extra ITI after timeout (ms)
        stimulusDuration: null,           // null = until response
        maxResponseTime: 5000,            // ms before timeout
        breakBetweenBlocks: true,         // Show break screen between blocks
        adaptiveSelection: false,         // Use random stimulus selection for training
        warmupBlocks: 3,                  // Random selection for first N blocks before adaptive kicks in
    },

    // Transfer parameters
    transfer: {
        totalTrials: 128,                 // Total transfer trials (4 per item with 32 items on average)
        trialsPerBreak: 20,               // Show break screen every N trials
        feedbackDuration: 0,              // No feedback in transfer
        itiDuration: 500,
        timeoutExtraITI: 1000,            // Extra ITI after timeout (ms)
        stimulusDuration: null,
        maxResponseTime: 5000,
        adaptiveSelection: true,          // Online ADO: pick max-IG item at each trial based on current α posterior
        minSpacing: 3,                    // Minimum items between repeats of same stimulus (for offline schedule fallback)
        minPresentations: 2,              // Minimum presentations per item (offline schedule only)
        maxPresentations: 8,              // Maximum presentations per item (offline schedule only)
        adaptiveMaxPerItem: 12,           // Cap on per-item presentations under online ADO; prevents degenerate cycling
        adaptiveSkipLastItem: true,       // Avoid presenting the same item twice in a row
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
const LOOKUP_TABLES_URL = "https://andrew-stier.github.io/adaptive_category_learning_qualtrics/lookup_tables_minimal.json?v=7";

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

    // Response state - prevents multiple key presses and presses during feedback/ITI
    acceptingResponse: false, // Only true when stimulus is shown and waiting for first response

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
 *   - dimensionOrder: Which physical dimension [0-4] maps to abstract dimension [0-4]
 *   - polarityFlips: Whether to flip 0↔1 for each dimension
 *   - labelSwap: Whether to swap category labels
 *   - conditionCode: Unique identifier for this counterbalance condition
 */
function generateCounterbalance(participantId) {
    const seed = stringToSeed(participantId || Math.random().toString());
    const rng = seededRandom(seed);

    // Shuffle dimension assignment (which physical dim = which abstract dim) - 5 dimensions
    const dimensionOrder = seededShuffle([0, 1, 2, 3, 4], rng);

    // Randomly flip polarity for each dimension - 5 dimensions
    const polarityFlips = [
        rng() > 0.5,
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
 * Abstract features: The logical feature vector from the category structure [D1, D2, D3, D4, D5]
 * Physical features: What the participant actually sees [Body, Antenna, Eyes, Pattern, Tail]
 */
function abstractToPhysical(abstractFeatures, counterbalance) {
    const physical = new Array(5);

    for (let physicalDim = 0; physicalDim < 5; physicalDim++) {
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

/**
 * Calculate presentation counts based on alpha estimate from training.
 * Uses hybrid approach: minimum counts for all + extra for high-info-gain items.
 */
function calculatePresentationCounts() {
    const tables = ExperimentState.lookupTables;
    const totalTrials = CONFIG.transfer.totalTrials;
    const minPres = CONFIG.transfer.minPresentations;
    const maxPres = CONFIG.transfer.maxPresentations;
    const allItems = tables.transfer_items.map(item => item.id);
    const numItems = allItems.length;

    // Log current alpha estimate from training
    const alphaEst = estimateAlpha();
    console.log('[CategoryLearning] Alpha estimate from training:', {
        mapEstimate: alphaEst.mapEstimate,
        expectedValue: alphaEst.expectedValue?.toFixed(2)
    });

    // Calculate information gain for each item using current alpha belief
    const infoGains = {};
    for (const itemId of allItems) {
        infoGains[itemId] = computeInformationGain(itemId);
    }

    console.log('[CategoryLearning] Information gains per item:', infoGains);

    // Start with minimum presentations for all items
    const itemCounts = {};
    for (const itemId of allItems) {
        itemCounts[itemId] = minPres;
    }

    // Calculate remaining trials to distribute
    let usedTrials = numItems * minPres;
    let remainingTrials = totalTrials - usedTrials;

    // Distribute extra trials proportionally to information gain
    const totalIG = Object.values(infoGains).reduce((a, b) => a + b, 0);

    if (totalIG > 0 && remainingTrials > 0) {
        // Sort items by info gain (highest first)
        const sortedItems = allItems.slice().sort((a, b) => infoGains[b] - infoGains[a]);

        // Distribute extra trials proportionally
        for (const itemId of sortedItems) {
            if (remainingTrials <= 0) break;

            const proportion = infoGains[itemId] / totalIG;
            const extraTrials = Math.round(proportion * (totalTrials - numItems * minPres));
            const canAdd = Math.min(extraTrials, maxPres - itemCounts[itemId], remainingTrials);

            if (canAdd > 0) {
                itemCounts[itemId] += canAdd;
                remainingTrials -= canAdd;
            }
        }

        // If still have remaining trials (due to rounding), distribute to highest IG items
        let idx = 0;
        while (remainingTrials > 0 && idx < sortedItems.length) {
            const itemId = sortedItems[idx % sortedItems.length];
            if (itemCounts[itemId] < maxPres) {
                itemCounts[itemId]++;
                remainingTrials--;
            }
            idx++;
            // Prevent infinite loop if all items at max
            if (idx > sortedItems.length * maxPres) break;
        }
    }

    return itemCounts;
}

/**
 * Generate a pre-computed transfer schedule with spacing constraints.
 * Uses alpha-based presentation counts and ensures minimum spacing between repeats.
 */
function generateTransferSchedule() {
    const minSpacing = CONFIG.transfer.minSpacing;

    // Calculate presentation counts based on alpha estimate
    const itemCounts = calculatePresentationCounts();

    console.log('[CategoryLearning] Alpha-based presentation counts:', itemCounts);

    // Create pool of all item presentations
    const pool = [];
    for (const [itemId, count] of Object.entries(itemCounts)) {
        for (let i = 0; i < count; i++) {
            pool.push(itemId);
        }
    }

    console.log('[CategoryLearning] Total presentations in pool:', pool.length);

    // Shuffle the pool
    const shuffled = shuffleArray(pool);

    // Build schedule with spacing constraints
    const schedule = [];
    const remaining = [...shuffled];
    const recentItems = []; // Track last N items for spacing

    let attempts = 0;
    const maxAttempts = remaining.length * 100; // Prevent infinite loop

    while (remaining.length > 0 && attempts < maxAttempts) {
        attempts++;

        // Find items that satisfy spacing constraint
        const validIndices = [];
        for (let i = 0; i < remaining.length; i++) {
            const item = remaining[i];
            // Check if this item was shown in the last minSpacing trials
            if (!recentItems.slice(-minSpacing).includes(item)) {
                validIndices.push(i);
            }
        }

        // If no valid items (spacing constraint too tight), relax it
        let chosenIndex;
        if (validIndices.length > 0) {
            // Pick randomly from valid items
            chosenIndex = validIndices[Math.floor(Math.random() * validIndices.length)];
        } else {
            // Fallback: pick the item that was shown longest ago
            let bestIndex = 0;
            let bestDistance = -1;
            for (let i = 0; i < remaining.length; i++) {
                const item = remaining[i];
                const lastSeen = recentItems.lastIndexOf(item);
                const distance = lastSeen === -1 ? Infinity : recentItems.length - lastSeen;
                if (distance > bestDistance) {
                    bestDistance = distance;
                    bestIndex = i;
                }
            }
            chosenIndex = bestIndex;
        }

        const chosenItem = remaining[chosenIndex];
        schedule.push(chosenItem);
        remaining.splice(chosenIndex, 1);
        recentItems.push(chosenItem);
    }

    console.log('[CategoryLearning] Generated transfer schedule with', schedule.length, 'trials');

    // Log summary of actual counts
    const actualCounts = {};
    for (const item of schedule) {
        actualCounts[item] = (actualCounts[item] || 0) + 1;
    }
    console.log('[CategoryLearning] Final presentation counts:', actualCounts);

    return schedule;
}

function selectNextTransferItem() {
    const tables = ExperimentState.lookupTables;

    // Use pre-computed schedule if not using online adaptive selection
    if (!CONFIG.transfer.adaptiveSelection) {
        // Generate schedule if not already done
        if (!ExperimentState.transferSchedule || ExperimentState.transferSchedule.length === 0) {
            ExperimentState.transferSchedule = generateTransferSchedule();
            ExperimentState.transferScheduleIndex = 0;
        }

        // Get next item from schedule
        const index = ExperimentState.transferScheduleIndex;
        if (index < ExperimentState.transferSchedule.length) {
            const itemId = ExperimentState.transferSchedule[index];
            ExperimentState.transferScheduleIndex++;
            console.log(`[CategoryLearning] Schedule item ${index + 1}/${ExperimentState.transferSchedule.length}: ${itemId}`);
            return itemId;
        } else {
            // Fallback: random selection if schedule exhausted
            const allItems = tables.transfer_items.map(item => item.id);
            return allItems[Math.floor(Math.random() * allItems.length)];
        }
    }

    // Online ADO: pick item with highest expected information gain about α
    // under the current posterior belief.
    // - Cap each item at adaptiveMaxPerItem presentations to prevent degenerate
    //   cycling on a single highest-IG item.
    // - Soft anti-repetition: skip the immediately preceding item unless it is
    //   strictly the most informative remaining option.
    const allItems = tables.transfer_items.map(item => item.id);
    const presentationCounts = {};
    for (const id of allItems) {
        presentationCounts[id] = ExperimentState.transferData.filter(t => t.itemId === id).length;
    }

    const maxPerItem = CONFIG.transfer.adaptiveMaxPerItem || 12;
    let available = allItems.filter(id => presentationCounts[id] < maxPerItem);
    if (available.length === 0) {
        // All items hit the cap — relax it (shouldn't happen with default 32 items × 12 cap = 384 ≫ 128)
        available = allItems;
    }

    // Soft anti-back-to-back: skip the immediately preceding item if there's an alternative
    const lastItem = ExperimentState.lastTransferItem;
    if (CONFIG.transfer.adaptiveSkipLastItem && lastItem && available.length > 1) {
        const filtered = available.filter(id => id !== lastItem);
        if (filtered.length > 0) available = filtered;
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
    console.log(`[CategoryLearning] Adaptive: selected ${bestItem} (presentation #${count}) with info gain ${bestIG.toFixed(6)}`);
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
            /* Hide cursor during trials */
            .exp-container.hide-cursor,
            .exp-container.hide-cursor * {
                cursor: none !important;
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
    // Enable response collection - only first key press will count
    ExperimentState.acceptingResponse = true;
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
    // Stop accepting responses (prevents key presses during feedback/ITI)
    ExperimentState.acceptingResponse = false;
    ExperimentState.responseHandler = null;

    // Clear timeout
    if (ExperimentState.timeoutId) {
        clearTimeout(ExperimentState.timeoutId);
        ExperimentState.timeoutId = null;
    }

    const correct = response === correctCategory;
    const timeout = response === -1;

    // Update alpha belief during training (for transfer schedule calculation)
    // Skip first 2 blocks since responses are likely random guessing
    const minBlocksForAlpha = 2;
    if (!timeout && ExperimentState.alphaBelief && ExperimentState.blockNum >= minBlocksForAlpha) {
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

    // Continue to next trial after feedback (extra ITI if timeout)
    const itiDuration = timeout
        ? CONFIG.training.itiDuration + CONFIG.training.timeoutExtraITI
        : CONFIG.training.itiDuration;

    setTimeout(() => {
        clearFeedback();
        showFixation();
        setTimeout(runTrainingTrial, itiDuration);
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

    // Keep cursor hidden during break (consistent with trial experience)
    hideCursor();

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

    // Show cursor again before navigating to transfer instructions
    showCursor();

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
    // Stop accepting responses (prevents key presses during feedback/ITI)
    ExperimentState.acceptingResponse = false;
    ExperimentState.responseHandler = null;

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

    // Check if it's time for a break (every N trials, but not at the end)
    const trialsCompleted = ExperimentState.trialNum;
    const breakFreq = CONFIG.transfer.trialsPerBreak;
    const needsBreak = breakFreq > 0 &&
                       trialsCompleted % breakFreq === 0 &&
                       trialsCompleted < CONFIG.transfer.totalTrials;

    if (needsBreak) {
        // Show break screen
        showFixation();
        setTimeout(() => {
            showTransferBreak();
        }, CONFIG.transfer.itiDuration);
    } else {
        // Continue to next trial (no feedback in transfer, extra ITI if timeout)
        const itiDuration = timeout
            ? CONFIG.transfer.itiDuration + CONFIG.transfer.timeoutExtraITI
            : CONFIG.transfer.itiDuration;

        showFixation();
        setTimeout(runTransferTrial, itiDuration);
    }
}

function showTransferBreak() {
    console.log('[CategoryLearning] Showing transfer break after trial', ExperimentState.trialNum);

    // Keep cursor hidden during break (consistent with trial experience)
    hideCursor();

    const stimContainer = document.getElementById('stimulus-container');
    const keyReminder = document.getElementById('key-reminder');
    const feedbackDiv = document.getElementById('feedback');
    const startScreen = document.getElementById('start-screen');

    if (stimContainer) stimContainer.style.display = 'none';
    if (keyReminder) keyReminder.style.display = 'none';
    if (feedbackDiv) feedbackDiv.textContent = '';

    // Show break screen
    if (startScreen) {
        startScreen.innerHTML = `
            <span class="fixation">+</span>
            <div class="start-prompt">Take a short break<br><br>Press <strong>SPACEBAR</strong> to continue</div>
        `;
        startScreen.style.display = 'block';
    }
    ExperimentState.waitingForStart = true;
}

function endTransferPhase() {
    const alphaEstimate = estimateAlpha();

    console.log(`[CategoryLearning] Transfer complete. Alpha estimate: ${alphaEstimate.expectedValue.toFixed(2)}`);

    // Show cursor again
    showCursor();

    // Reset background colors to white
    document.body.style.backgroundColor = '';
    if (typeof jQuery !== 'undefined') {
        jQuery('.SkinInner').css('background-color', '');
        jQuery('.Skin').css('background-color', '');
        jQuery('body').css('background-color', '');
    }

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
        // Ignore key repeats (holding down a key)
        if (event.repeat) return;

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

        // Handle category responses - only accept if we're waiting for a response
        // This prevents multiple key presses and key presses during feedback/ITI
        if (!ExperimentState.acceptingResponse || !ExperimentState.responseHandler) return;

        const rt = Date.now() - ExperimentState.trialStartTime;

        let response = null;

        if (key === CONFIG.keys.categoryA) {
            response = 0;  // Category A
        } else if (key === CONFIG.keys.categoryB) {
            response = 1;  // Category B
        }

        if (response !== null) {
            // Immediately stop accepting responses to prevent double presses
            ExperimentState.acceptingResponse = false;
            const handler = ExperimentState.responseHandler;
            ExperimentState.responseHandler = null;
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

function hideCursor() {
    const expContainer = document.getElementById('exp-container');
    if (expContainer) {
        expContainer.classList.add('hide-cursor');
        expContainer.style.cursor = 'none';
    }
    // Also hide on document body as fallback
    document.body.style.cursor = 'none';
}

function showCursor() {
    const expContainer = document.getElementById('exp-container');
    if (expContainer) {
        expContainer.classList.remove('hide-cursor');
        expContainer.style.cursor = '';
    }
    document.body.style.cursor = '';
}

function startTrials() {
    console.log('[CategoryLearning] Starting trials');
    const startScreen = document.getElementById('start-screen');
    const stimContainer = document.getElementById('stimulus-container');
    const keyReminder = document.getElementById('key-reminder');

    if (startScreen) startScreen.style.display = 'none';
    if (stimContainer) stimContainer.style.display = 'flex';
    if (keyReminder) keyReminder.style.display = 'flex';

    // Hide cursor during trials
    hideCursor();

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
        ExperimentState.transferSchedule = null;  // Will be generated using alpha from training
        ExperimentState.transferScheduleIndex = 0;
        // Note: alphaBelief is NOT reset - we keep the estimate from training
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

    // Initialize alpha belief - needed for:
    // - Adaptive training selection (if enabled)
    // - Alpha-dependent transfer schedule calculation
    // - Transfer phase belief tracking
    // Only initialize if not already set (preserve training estimates for transfer)
    if (!ExperimentState.alphaBelief) {
        initializeAlphaBelief();
        console.log('[CategoryLearning] Initialized alpha belief (uniform prior)');
    } else if (phase === "transfer") {
        console.log('[CategoryLearning] Using alpha belief from training for transfer schedule');
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
