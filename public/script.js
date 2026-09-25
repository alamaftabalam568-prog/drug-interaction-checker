// --- DICTIONARY DATABASE FOR AUTO-SUGGEST (suggestions only; live data no longer limited to this list) ---
const masterDrugList = [
  "paracetamol",
  "acetaminophen",
  "aspirin",
  "ibuprofen",
  "diclofenac",
  "naproxen",
  "benzocaine",
  "lidocaine",
  "atropine",
  "adrenaline",
  "epinephrine",
  "noradrenaline",
  "levodopa",
  "salbutamol",
  "heparin",
  "warfarin",
  "clopidogrel",
  "amoxicillin",
  "ciprofloxacin",
  "azithromycin",
  "metformin",
  "atorvastatin",
  "omeprazole",
  "alcohol",
  "milk",
  "calcium"
];

// Feature 1: Suggestions Menu Engine
function showSuggestions(inputElement, boxId) {
  const query = inputElement.value.trim().toLowerCase();
  const box = document.getElementById(boxId);
  box.innerHTML = "";
  if (!query) return;

  const filtered = masterDrugList.filter((item) => item.startsWith(query));
  filtered.forEach((item) => {
    let div = document.createElement("div");
    div.className = "suggestion-item";
    div.innerText = item.charAt(0).toUpperCase() + item.slice(1);
    div.onclick = function () {
      inputElement.value = item;
      box.innerHTML = "";
    };
    box.appendChild(div);
  });
}

// Close dropdown if clicked anywhere else
document.addEventListener("click", function (e) {
  if (!e.target.closest(".input-group")) {
    document
      .querySelectorAll(".suggestion-box")
      .forEach((box) => (box.innerHTML = ""));
  }
});

// Feature 5: Dark Mode Toggle Logic
function toggleDarkMode() {
  const checkbox = document.getElementById("checkbox");
  const iconSpan = document.querySelector(".mode-icon");
  if (checkbox.checked) {
    document.documentElement.setAttribute("data-theme", "dark");
    iconSpan.innerText = "☀️";
  } else {
    document.documentElement.removeAttribute("data-theme");
    iconSpan.innerText = "🌙";
  }
}

// Voice Output Engine
function speakText(text) {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    let utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "hi-IN";
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  }
}

// ============================================================
// LIVE DRUG LOOKUP — openFDA Drug Label API
// Free, no API key needed, still active (unlike the old RxNav
// interaction endpoint which NLM shut down on Jan 2, 2024).
// Docs: https://open.fda.gov/apis/drug/label/
// ============================================================

// FDA labels use US/international generic names, which often differ from
// the names common in India/UK. Map the common ones so a search for
// "paracetamol" actually finds the FDA record (filed under "acetaminophen").
const drugNameSynonyms = {
  paracetamol: "acetaminophen",
  crocin: "acetaminophen",
  calpol: "acetaminophen",
  dolo: "acetaminophen",
  panadol: "acetaminophen",
  salbutamol: "albuterol",
  ventolin: "albuterol",
  adrenaline: "epinephrine",
  noradrenaline: "norepinephrine",
  frusemide: "furosemide",
  lasix: "furosemide",
  augmentin: "amoxicillin"
};

function buildNameVariants(drugName) {
  const lower = drugName.toLowerCase().trim();
  const variants = [lower];
  if (drugNameSynonyms[lower]) variants.push(drugNameSynonyms[lower]);
  return [...new Set(variants)];
}

// Trims long label paragraphs down to something readable in a card/alert
function shortenText(rawArray, maxLen = 280) {
  if (!rawArray || !rawArray.length) return null;
  let text = rawArray[0].replace(/\s+/g, " ").trim();
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

// Tries a list of fields in priority order and returns the first one that
// has content. Needed because OTC "Drug Facts" labels often leave
// adverse_reactions empty and put the same info under warnings/stop_use instead.
function pickFirstText(record, fieldNames, maxLen = 280) {
  for (let f of fieldNames) {
    const text = shortenText(record[f], maxLen);
    if (text) return text;
  }
  return null;
}

// Looks up ONE drug name against openFDA. Tries brand name, then generic
// name, then active-substance name — across both the typed name and any
// known synonym — since a person might type any of these.
async function fetchLiveDrugInfo(drugName) {
  const searchFields = [
    "openfda.brand_name",
    "openfda.generic_name",
    "openfda.substance_name"
  ];
  const nameVariants = buildNameVariants(drugName);

  for (let variant of nameVariants) {
    for (let field of searchFields) {
      try {
        const queryStr = `${field}:"${variant}"`;
        const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(
          queryStr
        )}&limit=1`;
        const res = await fetch(url);
        if (!res.ok) continue; // openFDA returns 404 when nothing matches — just try the next field

        const data = await res.json();
        if (data.results && data.results.length > 0) {
          const r = data.results[0];
          const openfda = r.openfda || {};
          return {
            found: true,
            canonicalName:
              (openfda.brand_name && openfda.brand_name[0]) ||
              (openfda.generic_name && openfda.generic_name[0]) ||
              drugName,
            // Aliases are used later to cross-check this drug against the
            // OTHER entered drugs inside this drug's own interactions text.
            aliases: [
              drugName,
              ...nameVariants,
              ...(openfda.brand_name || []),
              ...(openfda.generic_name || []),
              ...(openfda.substance_name || [])
            ].map((a) => a.toLowerCase()),
            route: (openfda.route && openfda.route[0]) || null,
            indicationsDisplay: pickFirstText(r, [
              "indications_and_usage",
              "purpose"
            ]),
            adverseDisplay: pickFirstText(r, [
              "adverse_reactions",
              "warnings_and_cautions",
              "warnings",
              "precautions",
              "stop_use",
              "do_not_use"
            ]),
            warningsDisplay: pickFirstText(r, [
              "warnings_and_cautions",
              "warnings",
              "boxed_warning"
            ]),
            // Full, untruncated text used only for interaction matching, not display
            interactionsRaw: r.drug_interactions
              ? r.drug_interactions.join(" ").toLowerCase()
              : "",
            interactionsDisplay: shortenText(r.drug_interactions)
          };
        }
      } catch (e) {
        // network hiccup on this field — try the next one
      }
    }
  }
  return { found: false };
}

// Main Interactive Pipeline
async function analyzePrescription() {
  const d1 = document.getElementById("drug1").value.trim().toLowerCase();
  const d2 = document.getElementById("drug2").value.trim().toLowerCase();
  const d3 = document.getElementById("drug3").value.trim().toLowerCase();

  if (!d1 || !d2) {
    alert("⚠️ Kripya kam se kam do dawaiyon ke naam zaroor daalein!");
    speakText("Kripya kam se kam do dawaiyon ke naam zaroor daalein!");
    return;
  }

  // Feature 4: Fire Animated Glassmorphism Loader View
  document.getElementById("inputPage").style.display = "none";
  document.getElementById("loadingScreen").style.display = "block";

  let selectedDrugs = [d1, d2];
  if (d3) selectedDrugs.push(d3);
  let uniqueDrugs = [...new Set(selectedDrugs)];

  const statusDiv = document.getElementById("statusResult");
  const tableBody = document.getElementById("tableBody");
  const alertsContainer = document.getElementById("adverseAlertsContainer");

  try {
    let drugProfiles = {};
    let interactionFound = false;
    let conflictReasons = [];
    let speechText = "";
    let anyLiveDataFound = false;

    // Clinical Lifestyle & Diet Core Triggers (kept as a fast manual safety net —
    // these aren't real "drugs" so openFDA won't reliably cover them)
    let hasAlcohol = uniqueDrugs.includes("alcohol");
    let hasMilkOrCalcium = uniqueDrugs.some(
      (d) => d === "milk" || d === "calcium"
    );
    let hasParacetamol = uniqueDrugs.some(
      (d) => d === "paracetamol" || d === "acetaminophen"
    );
    let hasAntibiotic = uniqueDrugs.some(
      (d) =>
        d.endsWith("cillin") ||
        d.endsWith("floxacin") ||
        d.endsWith("mycin") ||
        d === "azithromycin"
    );

    if (hasAlcohol && hasParacetamol) {
      interactionFound = true;
      conflictReasons.push(
        "🛑 <b>CRITICAL INTERACTION (Paracetamol + Alcohol):</b> Heavy chronic drinking ya direct usage me liver enzymes alter ho jate hain, jisse hepatotoxic metabolites badhne se acute liver failure ka genuine threat ban jata hai."
      );
      speechText += "Paracetamol aur alcohol liver ke liye unsafe hai. ";
    }
    if (hasMilkOrCalcium && hasAntibiotic) {
      interactionFound = true;
      conflictReasons.push(
        "🥛 <b>DIET INTERACTION (Antibiotic + Calcium/Milk):</b> Doodh ka calcium antibiotic molecules ko chelate kar deta hai, jisse unka absorption cross barrier drop ho jata hai."
      );
      speechText += "Antibiotic ko milk ke sath bypass karein. ";
    }

    // --- LIVE FETCH: hit openFDA for every entered drug, in parallel ---
    const liveResults = await Promise.all(
      uniqueDrugs.map((drug) => {
        if (drug === "alcohol" || drug === "milk" || drug === "calcium") {
          return Promise.resolve({ found: false });
        }
        return fetchLiveDrugInfo(drug);
      })
    );
    uniqueDrugs.forEach((drug, i) => {
      drugProfiles[drug] = { input: drug, live: liveResults[i] };
      if (liveResults[i].found) anyLiveDataFound = true;
    });

    // --- REAL INTERACTION CROSS-CHECK using each drug's own FDA label ---
    // If Drug A's "drug_interactions" section mentions Drug B by any known
    // alias, flag it. This replaces the old RxNav interaction endpoint,
    // which NLM permanently discontinued.
    uniqueDrugs.forEach((drugA) => {
      const liveA = drugProfiles[drugA].live;
      if (!liveA.found || !liveA.interactionsRaw) return;
      uniqueDrugs.forEach((drugB) => {
        if (drugA === drugB) return;
        const liveB = drugProfiles[drugB].live;
        const aliasesB = liveB.found ? liveB.aliases : [drugB];
        const matched = aliasesB.some(
          (alias) => alias.length > 2 && liveA.interactionsRaw.includes(alias)
        );
        if (matched) {
          interactionFound = true;
          const nameA = liveA.canonicalName || drugA;
          const nameB = (liveB.found && liveB.canonicalName) || drugB;
          conflictReasons.push(
            `⚠️ <b>${nameA} label mentions ${nameB}:</b> ${
              liveA.interactionsDisplay ||
              "FDA label par dono dawaiyon ka concurrent mention hai — pharmacist se confirm karein."
            }`
          );
          speechText += `${nameA} aur ${nameB} ke beech FDA label me interaction note hai. `;
        }
      });
    });

    // --- Dynamic Pharmacological Cards Rendering ---
    tableBody.innerHTML = "";
    uniqueDrugs.forEach((drugKey) => {
      const live = drugProfiles[drugKey].live;
      let nameOut =
        live.found && live.canonicalName
          ? live.canonicalName
          : drugKey.toUpperCase();
      let routeOut = live.found && live.route ? live.route : "Oral";
      let freqOut = "As Directed";
      let usesOut =
        live.found && live.indicationsDisplay
          ? live.indicationsDisplay
          : "Live database me uses ki detail nahi mili.";
      let adverseOut =
        live.found && live.adverseDisplay
          ? live.adverseDisplay
          : "Live database me adverse reaction data nahi mila.";

      // Manual fallback only for non-drug substances that openFDA won't have
      let cleanKey = drugKey.toLowerCase().trim();
      if (!live.found) {
        if (cleanKey === "alcohol") {
          routeOut = "Ingestion";
          usesOut =
            "CNS Depressant — included for cross-checking against other drugs.";
          adverseOut =
            "Liver enzyme changes, dependency risk, tissue damage on chronic use.";
        } else if (cleanKey === "milk") {
          routeOut = "Oral";
          usesOut =
            "Dietary calcium source — included for chelation cross-checking.";
          adverseOut =
            "Can bind to certain antibiotics and reduce their absorption.";
        } else if (cleanKey === "calcium") {
          routeOut = "Oral / Supplement";
          usesOut = "Mineral supplement.";
          adverseOut =
            "Reduces absorption of certain antibiotics when taken together.";
        }
      }

      let row = `<tr>
                <td style="font-weight:700; color:var(--primary);">${nameOut}</td>
                <td style="color:#2563eb; font-weight:600;">${routeOut}</td>
                <td style="color:#d97706; font-weight:600;">${freqOut}</td>
                <td>${usesOut}</td>
                <td>${adverseOut}</td>
            </tr>`;
      tableBody.innerHTML += row;
    });

    // --- Adverse Effect Alerts panel (the part you asked for) ---
    let alertsHTML = "";
    uniqueDrugs.forEach((drugKey) => {
      const live = drugProfiles[drugKey].live;
      if (live.found && live.adverseDisplay) {
        const name = live.canonicalName || drugKey;
        alertsHTML += `<div class="adverse-alert">
                    <strong>⚠️ ${name} — Adverse Effects (FDA Label):</strong>
                    <p>${live.adverseDisplay}</p>
                    ${
                      live.warningsDisplay
                        ? `<p class="adverse-alert-warning"><b>Warning:</b> ${live.warningsDisplay}</p>`
                        : ""
                    }
                </div>`;
      }
    });
    alertsContainer.innerHTML = alertsHTML;

    // Toggle Loader Off and Display Final Analytical Screen
    document.getElementById("loadingScreen").style.display = "none";
    document.getElementById("resultPage").style.display = "block";

    if (interactionFound) {
      statusDiv.className = "result-box unsafe";
      statusDiv.innerHTML =
        `<h4>❌ POTENTIAL INTERACTION DETECTED</h4>` +
        conflictReasons.join("<br><br>");
      setTimeout(() => {
        alert("❌ INTERACTION RISK FOUND! Neeche poora report dekhein.");
      }, 100);
      speakText(
        "Attention! " +
          speechText +
          " Kripya doctor ya pharmacist se contact karein."
      );
    } else if (!anyLiveDataFound) {
      statusDiv.className = "result-box unsafe";
      statusDiv.innerHTML = `<h4>⚠️ LIVE DATABASE ME YEH DAWAI NAHI MILI</h4>FDA database me in naamo ka koi match nahi mila — spelling check karein ya generic naam try karein. Sirf manual safety rules check hue hain, koi conflict nahi mila, lekin yeh final clearance nahi hai.`;
      speakText(
        "Live database me yeh dawai nahi mili. Kripya spelling check karein ya doctor se confirm karein."
      );
    } else {
      statusDiv.className = "result-box safe";
      statusDiv.innerHTML = `<h4>✅ NO KNOWN INTERACTION FOUND</h4>Live FDA database aur manual rules — dono me koi conflict trace nahi mila. Neeche har dawai ke real adverse effects bhi dekh sakte hain.`;
      setTimeout(() => {
        alert("✅ No known interaction found. Adverse effects niche dekhein.");
      }, 100);
      speakText(
        "Koi known interaction nahi mila. Adverse effects report taiyaar hai."
      );
    }
  } catch (globalError) {
    document.getElementById("loadingScreen").style.display = "none";
    document.getElementById("resultPage").style.display = "block";
    statusDiv.className = "result-box unsafe";
    statusDiv.innerHTML = "<h4>⚠️ Execution Mismatch</h4>Check configurations.";
  }
}

// Feature 5: Native Window Print Router for Clean PDF Export
function downloadPDF() {
  window.print();
}

function clearAll() {
  document.getElementById("drug1").value = "";
  document.getElementById("drug2").value = "";
  document.getElementById("drug3").value = "";
  document
    .querySelectorAll(".suggestion-box")
    .forEach((box) => (box.innerHTML = ""));
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  document.getElementById("adverseAlertsContainer").innerHTML = "";
  document.getElementById("resultPage").style.display = "none";
  document.getElementById("inputPage").style.display = "block";
}
