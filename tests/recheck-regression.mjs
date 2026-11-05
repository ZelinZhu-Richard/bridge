// Cases that pass against the original validator; no type-aware assumptions.
import assert from "node:assert/strict";
import { loadAppRuntime } from "./app-runtime.mjs";

const app = loadAppRuntime();
const item = (type, term, question, options, correct_index = 0) => ({ type, term, question, options, correct_index, answer_text: options[correct_index], explanation: "The answer follows from the stated context." });
const validate = (pre, post) => app.validateRecheck({ kind: "immediate_recheck", items: [post] }, [pre]);
let n = 0;
function accept(name, pre, post) {
  const result = validate(pre, post);
  assert.equal(result.ok, true, `${name}: ${result.reason || ""}`); n++;
}
function reject(name, pre, post) {
  const result = validate(pre, post);
  assert.equal(result.ok, false, `${name}: true repeat was accepted`);
  n++;
}

const numeric = item("concept", "dot product", "What is (2, 1) · (3, 4)?", ["10", "12", "14", "16"]);
reject("concept literal repeat", numeric, { ...numeric });
reject("concept changed wording with unchanged correct option text", numeric, { ...numeric, question: "Calculate (2, 1) · (3, 4)." });
accept("concept parallel case with a different answer", numeric,
  item("concept", "dot product", "What is (1, 3) · (2, 4)?", ["14", "15", "16", "17"]));

const definition = item("concept", "independence", "A coin is flipped twice independently. What does the first result tell us about the second?",
  ["It does not change the second result's probabilities", "It forces a matching result", "It forces the opposite result", "It removes the second result"]);
accept("concept definition with new context and option wording", definition,
  item("concept", "independence", "A factory samples two independently produced bulbs. How does a defective first bulb affect the second bulb's defect probability?",
    ["The second bulb keeps its original defect probability", "The second bulb is certain to be defective", "The second bulb is certain to work", "The defect probability must double"]));

const language = item("language", "respectively", '"The height and width are large and small, respectively." What does respectively mean here?',
  ["The items pair in the same order", "The items pair in reverse order", "The items have equal values", "The items have no stated relation"]);
reject("language literal repeat", language, { ...language });
reject("language changed context with unchanged correct option text", language,
  { ...language, question: '"The mass and speed are low and high, respectively." How should these descriptions be paired?' });
accept("language new context and option wording", language,
  item("language", "respectively", '"The mass and speed are low and high, respectively." How should a reader pair these descriptions?',
    ["Low belongs to mass and high belongs to speed", "High belongs to mass and low belongs to speed", "Both descriptions belong only to speed", "Neither description belongs to either quantity"]));
console.log(`PASS ${n} original-validator regressions: concept and language duplicates and valid parallel items.`);
