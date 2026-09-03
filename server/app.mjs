import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const BASE_URL = "https://api.cheaperinference.com/v1";
const MAX_HISTORY_MESSAGES = 14;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const modeInstructions = {
  Explicar: `Explica el concepto con lenguaje sencillo, sin infantilizar. Estructura la respuesta así cuando sea útil:
1) Idea central en palabras normales.
2) Paso a paso.
3) Un ejemplo concreto.
4) Una frase de "Qué debes recordar".
Evita definiciones densas al comienzo.`,
  Sintetizar: `Sintetiza el tema para estudiar rápido. Da entre 5 y 8 puntos esenciales, distingue lo indispensable de lo secundario y termina con "En una frase". No conviertas la respuesta en un ensayo.`,
  Ejemplo: `Prioriza los ejemplos por encima de la teoría. Da primero un ejemplo cotidiano y después, si encaja con la materia, uno académico, de IA o programación. Explica exactamente qué parte del ejemplo representa cada concepto.`,
  "Otra forma": `El estudiante indica que la explicación anterior no funcionó. NO repitas la misma redacción, analogía ni estructura. Cambia de estrategia: usa una analogía nueva, divide el concepto en pasos más pequeños y señala la confusión típica. Termina con una comprobación muy breve del tipo "Si X ocurre, ¿qué esperarías que pase?", pero no reveles la respuesta salvo que el usuario la pida.`
};

function summarizeLearningProfile(learningProfile) {
  if (!learningProfile || typeof learningProfile !== "object") return "";
  const hasMastery = learningProfile.mastery !== null && learningProfile.mastery !== undefined && Number.isFinite(Number(learningProfile.mastery));
  const mastery = hasMastery ? `${Math.max(0, Math.min(100, Number(learningProfile.mastery)))}%` : "sin medir";
  const quizzes = Math.max(0, Number(learningProfile.quizzesCompleted) || 0);
  const difficultySignals = Math.max(0, Number(learningProfile.difficultySignals) || 0);
  const concepts = Array.isArray(learningProfile.concepts)
    ? learningProfile.concepts
        .filter((item) => item && typeof item.name === "string")
        .slice(0, 12)
        .map((item) => `${String(item.name).slice(0, 100)}: ${Math.max(0, Math.min(100, Number(item.score) || 0))}% (${Math.max(0, Number(item.total) || 0)} evidencias)`)
    : [];

  return [
    `Dominio global estimado: ${mastery}`,
    `Quizzes completados: ${quizzes}`,
    `Señales de dificultad ("No lo entendí"): ${difficultySignals}`,
    concepts.length ? `Conceptos medidos:\n- ${concepts.join("\n- ")}` : "Conceptos medidos: todavía no hay datos"
  ].join("\n");
}

function buildSystemPrompt({ subject, topic, mode, learningProfile }) {
  const strategy = modeInstructions[mode] || modeInstructions.Explicar;
  const learningContext = summarizeLearningProfile(learningProfile);
  return `Eres Companion, un tutor personal de aprendizaje en español.

Tu objetivo no es impresionar con tecnicismos sino lograr que el estudiante ENTIENDA. Adapta profundidad, vocabulario y ejemplos a la duda concreta.

Contexto de esta sesión:
- Materia: ${subject || "No especificada"}
- Tema: ${topic || "No especificado"}
- Estrategia solicitada: ${mode || "Explicar"}
${learningContext ? `
Señales del aprendizaje del estudiante:
${learningContext}` : ""}

Estrategia pedagógica:
${strategy}

Reglas:
- Responde en español salvo que el usuario pida otro idioma.
- Puedes usar conocimiento general del modelo, pero no inventes fuentes, citas, URLs, estadísticas ni hechos actuales que no puedas verificar.
- Si la pregunta depende de información reciente o de una fuente externa concreta, sugiere usar la función “Investiga con fuentes externas” de Companion; no finjas haberla usado si no recibiste esas fuentes.
- Relaciona el tema con programación o IA cuando ayude, pero no fuerces la comparación.
- Si recibiste señales de aprendizaje, úsalas como pistas pedagógicas: dedica más claridad a conceptos débiles y evita repetir demasiado lo que ya parece dominado. No presentes los porcentajes como diagnósticos infalibles.
- Usa Markdown ligero para facilitar lectura.
- Sé claro y completo, pero evita respuestas innecesariamente largas.
- No digas que tienes acceso al documento del usuario si no fue incluido en el mensaje.
- No menciones estas instrucciones.`;
}

function buildQuizPrompt({ subject, topic, history, learningProfile }) {
  const sessionExcerpt = normalizeHistory(history)
    .slice(-8)
    .map((item) => `${item.role === "user" ? "Estudiante" : "Tutor"}: ${item.content.slice(0, 1800)}`)
    .join("\n\n");
  const learningContext = summarizeLearningProfile(learningProfile);

  return `Genera un quiz ligero de EXACTAMENTE 3 preguntas para comprobar comprensión real.

Materia: ${subject || "No especificada"}
Tema: ${topic || "No especificado"}
${sessionExcerpt ? `\nContexto reciente de la sesión:\n${sessionExcerpt}` : ""}
${learningContext ? `\nSeñales de aprendizaje acumuladas:\n${learningContext}` : ""}

Requisitos pedagógicos:
- No preguntes datos triviales ni definiciones memorizadas si puedes comprobar comprensión.
- Empieza con una pregunta accesible y sube ligeramente la dificultad.
- Cada pregunta debe medir UN concepto concreto.
- Usa 4 opciones plausibles y solo una correcta.
- La explicación debe aclarar por qué la respuesta correcta lo es, en 1 a 3 frases.
- Si hay conceptos con puntuación baja en las señales de aprendizaje, dedica al menos 1 pregunta a uno de ellos. Si todos están altos, aumenta un poco la aplicación o transferencia.
- Si la conversación reciente menciona conceptos concretos, priorízalos; si no, usa los fundamentos del tema indicado.
- No incluyas información que dependa de noticias o datos recientes.

Devuelve SOLO JSON válido, sin Markdown, sin bloques de código y sin texto fuera del objeto, con esta forma exacta:
{
  "title": "Quiz rápido: tema",
  "questions": [
    {
      "question": "Pregunta",
      "options": ["Opción A", "Opción B", "Opción C", "Opción D"],
      "answerIndex": 0,
      "explanation": "Explicación breve",
      "concept": "Nombre corto del concepto"
    }
  ]
}

answerIndex debe ser un entero entre 0 y 3.`;
}

function normalizeHistory(history = []) {
  return history
    .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({ role, content: content.slice(0, 12000) }));
}

function friendlyProviderError(status, rawText) {
  let providerMessage = "";
  try {
    const parsed = JSON.parse(rawText);
    providerMessage = parsed?.error?.message || parsed?.message || "";
  } catch {
    providerMessage = rawText?.slice(0, 240) || "";
  }

  if (status === 401) return "La API key de Cheaper Inference no es válida o ya no está activa.";
  if (status === 402) return "Cheaper Inference indica que no hay saldo suficiente para completar la solicitud.";
  if (status === 429) return "El proveedor está limitando temporalmente las solicitudes. Intenta de nuevo en unos segundos.";
  if (status === 503) return providerMessage || "El modelo no está disponible en este momento. Prueba de nuevo o cambia CHEAPER_INFERENCE_MODEL.";
  return providerMessage || `Cheaper Inference respondió con el estado ${status}.`;
}

function getApiConfig() {
  return {
    apiKey: process.env.CHEAPER_INFERENCE_API_KEY,
    model: process.env.CHEAPER_INFERENCE_MODEL || "gpt-5.4"
  };
}


function decodeHtmlEntities(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function cleanSnippet(value = "") {
  return decodeHtmlEntities(String(value))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function extractYear(item) {
  const dateParts = item?.["published-print"]?.["date-parts"]
    || item?.["published-online"]?.["date-parts"]
    || item?.issued?.["date-parts"];
  return Array.isArray(dateParts?.[0]) && dateParts[0][0] ? String(dateParts[0][0]) : "";
}

function formatAuthors(authors = []) {
  if (!Array.isArray(authors) || !authors.length) return "";
  const names = authors
    .slice(0, 3)
    .map((author) => [author?.given, author?.family].filter(Boolean).join(" ").trim())
    .filter(Boolean);
  if (!names.length) return "";
  return `${names.join(", ")}${authors.length > 3 ? " et al." : ""}`;
}

async function fetchJson(url, options = {}, timeoutMs = 14000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getWikipediaIntro(title) {
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    format: "json",
    titles: title
  });
  const url = `https://es.wikipedia.org/w/api.php?${params.toString()}`;
  try {
    const payload = await fetchJson(url, {
      headers: { "User-Agent": "CompanionStudyTutor/1.0 (local educational project)" }
    }, 10000);
    const pages = payload?.query?.pages ? Object.values(payload.query.pages) : [];
    const extract = pages?.[0]?.extract;
    return cleanSnippet(extract || "");
  } catch {
    return "";
  }
}

async function searchWikipedia(query) {
  const url = `https://es.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=4`;
  try {
    const payload = await fetchJson(url, {
      headers: {
        "User-Agent": "CompanionStudyTutor/1.0 (local educational project)"
      }
    });
    const pages = Array.isArray(payload?.pages) ? payload.pages.slice(0, 4) : [];
    const intros = await Promise.all(pages.map((page) => getWikipediaIntro(String(page?.title || ""))));

    return pages.map((page, index) => {
      const title = String(page?.title || "Artículo de Wikipedia");
      const key = String(page?.key || title.replace(/ /g, "_"));
      const excerpt = cleanSnippet(page?.excerpt || page?.description || "Resultado enciclopédico relacionado con la consulta.");
      return {
        id: `W${index + 1}`,
        title,
        url: `https://es.wikipedia.org/wiki/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
        provider: "Wikipedia",
        kind: "encyclopedia",
        snippet: intros[index] || excerpt,
        meta: cleanSnippet(page?.description || "Enciclopedia")
      };
    });
  } catch {
    return [];
  }
}

async function searchCrossref(query) {
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: "4",
    sort: "relevance"
  });
  const mailto = process.env.CROSSREF_MAILTO?.trim();
  if (mailto) params.set("mailto", mailto);

  const url = `https://api.crossref.org/works?${params.toString()}`;
  try {
    const payload = await fetchJson(url, {
      headers: {
        "User-Agent": mailto
          ? `CompanionStudyTutor/1.0 (mailto:${mailto})`
          : "CompanionStudyTutor/1.0"
      }
    });
    const items = Array.isArray(payload?.message?.items) ? payload.message.items : [];
    return items.slice(0, 4).map((item, index) => {
      const title = Array.isArray(item?.title) && item.title[0] ? cleanSnippet(item.title[0]) : "Publicación académica";
      const container = Array.isArray(item?.["container-title"]) ? cleanSnippet(item["container-title"][0] || "") : "";
      const author = formatAuthors(item?.author);
      const year = extractYear(item);
      const doi = item?.DOI ? `https://doi.org/${item.DOI}` : "";
      const url = doi || item?.URL || "https://search.crossref.org/";
      const abstract = cleanSnippet(item?.abstract || "");
      const fallbackSnippet = [author, container, year, item?.publisher].filter(Boolean).join(" · ");

      return {
        id: `A${index + 1}`,
        title,
        url,
        provider: "Crossref",
        kind: "academic",
        snippet: abstract || fallbackSnippet || "Metadatos de una publicación académica relacionada con la consulta.",
        meta: [year, container || item?.publisher].filter(Boolean).join(" · ")
      };
    });
  } catch {
    return [];
  }
}

function buildResearchPrompt({ query, subject, topic, sources }) {
  const sourceText = sources.map((source) => [
    `[${source.id}] ${source.title}`,
    `Tipo: ${source.kind === "academic" ? "publicación académica" : "enciclopedia"}`,
    `Proveedor: ${source.provider}`,
    source.meta ? `Meta: ${source.meta}` : "",
    `Extracto/metadata: ${source.snippet}`,
    `URL: ${source.url}`
  ].filter(Boolean).join("\n")).join("\n\n");

  return `Eres Companion, un tutor que debe sintetizar SOLAMENTE la evidencia externa proporcionada.

Materia: ${subject || "No especificada"}
Tema actual: ${topic || "No especificado"}
Pregunta de investigación: ${query}

FUENTES RECUPERADAS:
${sourceText}

Reglas obligatorias:
- No inventes hechos, autores, fechas, estudios, citas textuales ni URLs.
- No uses conocimiento externo para rellenar huecos. Si las fuentes no bastan, indícalo en limits.
- Wikipedia sirve como apoyo explicativo; no la presentes como evidencia académica primaria.
- Las fuentes Crossref son metadatos bibliográficos: si no hay abstract, no atribuyas conclusiones específicas al artículo.
- Cada idea clave debe listar sourceIds reales de las fuentes que la respaldan.
- Escribe para que un estudiante entienda, no como una revisión sistemática.
- Si hay desacuerdo, ambigüedad o fuentes insuficientes, dilo claramente.

Devuelve SOLO JSON válido con esta forma:
{
  "answer": "Síntesis clara en 2 a 5 párrafos cortos",
  "keyPoints": [
    { "text": "Idea clave", "sourceIds": ["W1", "A1"] }
  ],
  "studyBridge": "Cómo conecta esta investigación con el tema que está estudiando",
  "limits": "Limitación relevante de esta búsqueda, o cadena vacía"
}`;
}

function validateResearch(raw, sources) {
  const validIds = new Set(sources.map((source) => source.id));
  const answer = String(raw?.answer || "").trim();
  if (!answer) throw new Error("El modelo no devolvió una síntesis utilizable.");

  const keyPoints = Array.isArray(raw?.keyPoints)
    ? raw.keyPoints.slice(0, 6).map((item) => ({
        text: String(item?.text || "").trim().slice(0, 700),
        sourceIds: Array.isArray(item?.sourceIds)
          ? item.sourceIds.map(String).filter((id) => validIds.has(id)).slice(0, 4)
          : []
      })).filter((item) => item.text)
    : [];

  return {
    answer: answer.slice(0, 7000),
    keyPoints,
    studyBridge: String(raw?.studyBridge || "Usa esta investigación como complemento del tema actual y contrástala con tu material principal.").trim().slice(0, 1400),
    limits: String(raw?.limits || "").trim().slice(0, 1000)
  };
}

function extractJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("El modelo no devolvió JSON válido.");
  }
}

function validateQuiz(raw, topic) {
  if (!raw || !Array.isArray(raw.questions) || raw.questions.length < 3) {
    throw new Error("El modelo no devolvió las 3 preguntas esperadas.");
  }

  const questions = raw.questions.slice(0, 3).map((item, index) => {
    const options = Array.isArray(item?.options) ? item.options.slice(0, 4).map(String) : [];
    const answerIndex = Number(item?.answerIndex);
    if (!item?.question || options.length !== 4 || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
      throw new Error(`La pregunta ${index + 1} no tiene el formato esperado.`);
    }

    return {
      question: String(item.question).slice(0, 700),
      options: options.map((option) => option.slice(0, 350)),
      answerIndex,
      explanation: String(item.explanation || "Revisa el concepto y vuelve a intentarlo.").slice(0, 900),
      concept: String(item.concept || topic || `Concepto ${index + 1}`).slice(0, 100)
    };
  });

  return {
    title: String(raw.title || `Quiz rápido: ${topic || "tema actual"}`).slice(0, 160),
    questions
  };
}


function buildAudioPrompt({ subject, topic, kind, focusText, history, learningProfile }) {
  const sessionExcerpt = normalizeHistory(history)
    .slice(-10)
    .map((item) => `${item.role === "user" ? "Estudiante" : "Tutor"}: ${item.content.slice(0, 2200)}`)
    .join("\n\n");
  const learningContext = summarizeLearningProfile(learningProfile);
  const isExplanation = kind === "explanation" && typeof focusText === "string" && focusText.trim();

  return `Prepara un guion EDUCATIVO para ser escuchado con síntesis de voz.

Materia: ${subject || "No especificada"}
Tema: ${topic || "No especificado"}
Tipo: ${isExplanation ? "versión oral de una explicación concreta" : "repaso hablado de la sesión"}
${learningContext ? `\nSeñales de aprendizaje:\n${learningContext}` : ""}
${isExplanation ? `\nTexto que debes transformar en explicación oral:\n${String(focusText).slice(0, 14000)}` : `\nConversación reciente:\n${sessionExcerpt || "No hay conversación suficiente; usa solo el tema y las señales disponibles."}`}

Reglas:
- Escribe para ESCUCHAR, no para leer: frases naturales, transiciones claras y sin listas rígidas en el guion.
- No leas símbolos de Markdown, URLs, IDs de fuentes ni encabezados como si fueran texto.
- Si es una explicación concreta, conserva su significado pero reorganízala para que suene conversacional; no agregues hechos nuevos innecesarios.
- Si es repaso de sesión, prioriza conceptos con menor puntuación o señales de dificultad, y menciona brevemente lo que ya parece fuerte.
- No inventes que el estudiante falló algo si no aparece en los datos.
- Duración objetivo: ${isExplanation ? "1 a 3 minutos" : "3 a 5 minutos"} a velocidad normal.
- Termina con UNA pregunta corta de recuerdo activo, sin dar la respuesta.
- Español claro, tono de tutor cercano y profesional.

Devuelve SOLO JSON válido:
{
  "title": "Título corto",
  "estimatedMinutes": 4,
  "script": "Guion continuo listo para voz",
  "focusPoints": ["Punto 1", "Punto 2", "Punto 3"],
  "closingQuestion": "Pregunta final"
}`;
}

function validateAudio(raw, isExplanation = false) {
  const script = String(raw?.script || "").trim();
  if (!script) throw new Error("El modelo no devolvió un guion de audio.");
  const estimated = Number(raw?.estimatedMinutes);
  return {
    title: String(raw?.title || (isExplanation ? "Explicación hablada" : "Repaso de la sesión")).trim().slice(0, 150),
    estimatedMinutes: Number.isFinite(estimated) ? Math.max(1, Math.min(7, Math.round(estimated))) : (isExplanation ? 2 : 4),
    script: script.slice(0, 14000),
    focusPoints: Array.isArray(raw?.focusPoints) ? raw.focusPoints.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5) : [],
    closingQuestion: String(raw?.closingQuestion || "¿Cuál es la idea más importante que recuerdas de este repaso?").trim().slice(0, 500)
  };
}

function buildAdaptivePlanPrompt({ subject, topic, history, learningProfile }) {
  const sessionExcerpt = normalizeHistory(history)
    .slice(-10)
    .map((item) => `${item.role === "user" ? "Estudiante" : "Tutor"}: ${item.content.slice(0, 1600)}`)
    .join("\n\n");
  const learningContext = summarizeLearningProfile(learningProfile);

  return `Actúa como tutor adaptativo y decide el SIGUIENTE PASO de estudio basándote únicamente en las señales disponibles.

Materia: ${subject || "No especificada"}
Tema: ${topic || "No especificado"}

Perfil de aprendizaje:
${learningContext || "Aún no hay medición objetiva."}

Conversación reciente:
${sessionExcerpt || "Sin conversación reciente."}

Tu decisión debe ser UNA de estas:
- diagnosticar: no hay evidencia suficiente.
- reforzar: existe una debilidad clara.
- consolidar: comprensión intermedia; necesita práctica antes de avanzar.
- avanzar: resultados sólidos; conviene profundizar/aplicar.

Reglas:
- No conviertas pocos datos en una certeza absoluta.
- Si un concepto tiene menos de 2 evidencias, trátalo con cautela.
- Las fortalezas/debilidades deben derivarse del perfil o de dificultades expresadas en la conversación.
- Diseña una micro-sesión total de 5 a 15 minutos, con 2 a 4 pasos.
- recommendedPrompt debe ser una instrucción lista para pegar en el chat de Companion y comenzar esa micro-sesión.
- nextCheckpoint debe describir una prueba observable para decidir si ya puede avanzar.

Devuelve SOLO JSON válido:
{
  "status": "reforzar",
  "headline": "Qué conviene hacer ahora",
  "diagnosis": "Explicación breve de por qué",
  "strengths": ["Concepto fuerte"],
  "weaknesses": ["Concepto a reforzar"],
  "steps": [
    { "label": "Paso", "minutes": 3, "instruction": "Qué hacer" }
  ],
  "recommendedPrompt": "Prompt listo para el tutor",
  "nextCheckpoint": "Criterio para avanzar"
}`;
}

function validateAdaptivePlan(raw, topic) {
  const allowed = new Set(["diagnosticar", "reforzar", "consolidar", "avanzar"]);
  const status = allowed.has(raw?.status) ? raw.status : "diagnosticar";
  const steps = Array.isArray(raw?.steps)
    ? raw.steps.slice(0, 4).map((item, index) => ({
        label: String(item?.label || `Paso ${index + 1}`).trim().slice(0, 100),
        minutes: Math.max(1, Math.min(10, Math.round(Number(item?.minutes) || 3))),
        instruction: String(item?.instruction || "Practica este punto con el tutor.").trim().slice(0, 650)
      }))
    : [];

  if (!steps.length) steps.push({ label: "Diagnóstico breve", minutes: 5, instruction: `Responde algunas preguntas sobre ${topic || "el tema"} para obtener una señal más fiable.` });

  return {
    status,
    headline: String(raw?.headline || "Obtengamos una señal más clara antes de avanzar").trim().slice(0, 180),
    diagnosis: String(raw?.diagnosis || "Todavía hay poca evidencia para adaptar el siguiente paso con precisión.").trim().slice(0, 1200),
    strengths: Array.isArray(raw?.strengths) ? raw.strengths.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5) : [],
    weaknesses: Array.isArray(raw?.weaknesses) ? raw.weaknesses.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5) : [],
    steps,
    recommendedPrompt: String(raw?.recommendedPrompt || `Hazme un diagnóstico breve sobre ${topic || "este tema"} y adapta la dificultad según mis respuestas.`).trim().slice(0, 1600),
    nextCheckpoint: String(raw?.nextCheckpoint || "Poder explicar la idea principal y resolver un ejemplo sin ayuda.").trim().slice(0, 800)
  };
}

async function requestJsonCompletion({ apiKey, model, system, user, timeoutMs = 90000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await upstream.text();
    if (!upstream.ok) {
      const error = new Error(friendlyProviderError(upstream.status, rawText));
      error.status = upstream.status;
      throw error;
    }

    const payload = JSON.parse(rawText);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("El modelo no devolvió contenido utilizable.");
    return extractJson(content);
  } finally {
    clearTimeout(timeout);
  }
}


function validateDocumentSection(raw, fallbackTitle = "Sección del documento") {
  const glossary = Array.isArray(raw?.glossary)
    ? raw.glossary
        .map((item) => ({
          term: String(item?.term || "").trim().slice(0, 120),
          meaning: String(item?.meaning || "").trim().slice(0, 700)
        }))
        .filter((item) => item.term && item.meaning)
        .slice(0, 24)
    : [];
  const explainedText = String(raw?.explainedText || "").trim();
  if (explainedText.length < 300) throw new Error("La explicación generada quedó demasiado corta para considerarla completa.");
  return {
    title: String(raw?.title || fallbackTitle).trim().slice(0, 180),
    explainedText: explainedText.slice(0, 50000),
    glossary,
    anchor: String(raw?.anchor || "Identifica la idea principal y cómo se conecta con los demás conceptos de esta sección.").trim().slice(0, 900)
  };
}

function validateCoverage(raw) {
  const score = Math.max(0, Math.min(100, Math.round(Number(raw?.score) || 0)));
  const missingPoints = Array.isArray(raw?.missingPoints)
    ? raw.missingPoints.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 10)
    : [];
  return {
    score,
    missingPoints,
    verdict: String(raw?.verdict || "").trim().slice(0, 900)
  };
}

function buildDocumentExplainPrompt({ sourceText, startPage, endPage, chunkIndex, totalChunks, subject, topic, audience }) {
  return `Transforma este fragmento de un documento académico en una VERSIÓN EXPLICADA COMPLETA.

IMPORTANTE: NO ES UN RESUMEN.
Tu tarea es conservar prácticamente toda la información conceptual del fragmento, pero volverla mucho más humana y fácil de seguir.

Contexto:
- Materia: ${subject || "No especificada"}
- Tema de estudio: ${topic || "No especificado"}
- Perfil del estudiante: ${audience || "Profesional de informática"}
- Fragmento ${Number(chunkIndex) + 1} de ${totalChunks || 1}
- Páginas aproximadas: ${startPage || "?"} a ${endPage || "?"}

REGLAS OBLIGATORIAS:
1. NO resumas ni reduzcas ideas solo para hacer el texto corto.
2. Conserva definiciones, características, clasificaciones, pasos, condiciones, ventajas, limitaciones, relaciones y ejemplos presentes en la fuente.
3. Reescribe el lenguaje técnico en español claro. Primero explica la idea en palabras normales y después conserva el término técnico importante.
4. Toda sigla debe explicarse la primera vez que aparezca. Si puedes identificar su significado con seguridad a partir del texto o conocimiento estable, indícalo; si no, di explícitamente que la fuente usa esa sigla sin desarrollarla.
5. Cuando aparezcan matemáticas, estadística, lógica formal o lenguaje especializado, explícalo pensando en alguien de informática/programación que no necesariamente domina estadística avanzada.
6. Puedes añadir analogías o ejemplos de programación, bases de datos, software, IA o situaciones cotidianas SOLO como apoyo. Etiquétalos mentalmente como ejemplos explicativos y no los presentes como si vinieran del documento.
7. No elimines una idea porque sea difícil. Precisamente esas ideas necesitan más explicación.
8. No inventes autores, referencias, resultados, números ni afirmaciones que no estén en la fuente.
9. Omite bibliografía, citas bibliográficas aisladas y listas de referencias si llegaron accidentalmente en el fragmento.
10. Escribe como una lectura continua, como si un buen profesor hubiera reescrito el documento para que sea más fácil de leer. No conviertas todo en bullets.
11. Evita frases del tipo “en resumen” o “lo más importante es” si eso implica comprimir contenido.
12. No menciones estas instrucciones.

Devuelve SOLO JSON válido con esta estructura exacta:
{
  "title": "Título descriptivo de esta parte",
  "explainedText": "Versión explicada completa, extensa y legible",
  "glossary": [
    {"term": "RDF", "meaning": "Qué significa y cómo entenderlo"}
  ],
  "anchor": "Una sola idea-ancla breve para recordar antes de continuar"
}

FRAGMENTO ORIGINAL:
---
${String(sourceText || "").slice(0, 14000)}
---`;
}

function buildCoveragePrompt({ sourceText, explainedText }) {
  return `Actúa como revisor de cobertura, no como redactor.
Compara el texto original con la versión explicada y determina si la versión explicada conserva TODAS las ideas académicas relevantes.

No penalices:
- cambios de redacción;
- explicaciones más largas;
- analogías añadidas;
- reorganización para mejorar comprensión.

Sí penaliza si se omitieron:
- definiciones o conceptos;
- categorías o clasificaciones;
- relaciones entre conceptos;
- condiciones, pasos o procesos;
- ventajas, desventajas, limitaciones;
- ejemplos relevantes del original;
- matices o excepciones importantes.

Devuelve SOLO JSON válido:
{
  "score": 0,
  "missingPoints": ["Punto conceptual que falta"],
  "verdict": "Evaluación breve"
}

Usa 100 únicamente cuando no detectes omisiones conceptuales materiales. Una paráfrasis correcta cuenta como cobertura completa.

TEXTO ORIGINAL:
---
${String(sourceText || "").slice(0, 14000)}
---

VERSIÓN EXPLICADA:
---
${String(explainedText || "").slice(0, 30000)}
---`;
}

function buildDocumentRepairPrompt({ sourceText, currentExplanation, missingPoints, subject, topic, audience }) {
  return `Revisa y COMPLETA una versión explicada de un documento académico.
La revisión independiente detectó ideas que podrían haberse perdido. Debes producir una nueva versión explicada COMPLETA que conserve todo lo que ya estaba bien y reincorpore cada punto faltante.

NO resumas. NO acortes por estilo. Mantén lenguaje humano y pedagógico para un estudiante con perfil: ${audience || "Profesional de informática"}.
Materia: ${subject || "No especificada"}
Tema: ${topic || "No especificado"}

Puntos que debes asegurar que queden explicados:
- ${(Array.isArray(missingPoints) ? missingPoints : []).map(String).join("\n- ")}

Devuelve SOLO JSON válido:
{
  "title": "Título descriptivo",
  "explainedText": "Versión explicada completa ya corregida",
  "glossary": [{"term":"Término","meaning":"Explicación"}],
  "anchor": "Idea-ancla breve"
}

ORIGINAL:
---
${String(sourceText || "").slice(0, 14000)}
---

VERSIÓN ACTUAL:
---
${String(currentExplanation || "").slice(0, 30000)}
---`;
}

app.post("/api/document-explain", async (req, res) => {
  const { apiKey, model } = getApiConfig();
  if (!apiKey) return res.status(500).json({ error: "Falta CHEAPER_INFERENCE_API_KEY." });
  const { sourceText, startPage, endPage, chunkIndex = 0, totalChunks = 1, subject, topic, audience } = req.body || {};
  if (!sourceText || typeof sourceText !== "string") return res.status(400).json({ error: "No recibí texto del documento para explicar." });
  try {
    const raw = await requestJsonCompletion({
      apiKey,
      model,
      timeoutMs: 52000,
      system: "Eres un profesor que reescribe documentos académicos completos para hacerlos comprensibles sin resumirlos. Devuelve únicamente el JSON solicitado.",
      user: buildDocumentExplainPrompt({ sourceText, startPage, endPage, chunkIndex, totalChunks, subject, topic, audience })
    });
    return res.json({ section: validateDocumentSection(raw, `Sección ${Number(chunkIndex) + 1}`) });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return res.status(status).json({
      error: error?.name === "AbortError"
        ? "Esta sección tardó demasiado en procesarse. Intenta nuevamente."
        : error instanceof Error ? error.message : "No pude explicar esta sección."
    });
  }
});

app.post("/api/document-coverage", async (req, res) => {
  const { apiKey, model } = getApiConfig();
  if (!apiKey) return res.status(500).json({ error: "Falta CHEAPER_INFERENCE_API_KEY." });
  const { sourceText, explainedText } = req.body || {};
  if (!sourceText || !explainedText) return res.status(400).json({ error: "Faltan textos para comprobar la cobertura." });
  try {
    const raw = await requestJsonCompletion({
      apiKey,
      model,
      timeoutMs: 52000,
      system: "Eres un auditor académico de cobertura. No reescribas el texto. Compara fuente y explicación y devuelve únicamente JSON válido.",
      user: buildCoveragePrompt({ sourceText, explainedText })
    });
    return res.json({ coverage: validateCoverage(raw) });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return res.status(status).json({ error: error instanceof Error ? error.message : "No pude comprobar la cobertura." });
  }
});

app.post("/api/document-repair", async (req, res) => {
  const { apiKey, model } = getApiConfig();
  if (!apiKey) return res.status(500).json({ error: "Falta CHEAPER_INFERENCE_API_KEY." });
  const { sourceText, currentExplanation, missingPoints = [], subject, topic, audience } = req.body || {};
  if (!sourceText || !currentExplanation) return res.status(400).json({ error: "Falta contenido para completar la sección." });
  try {
    const raw = await requestJsonCompletion({
      apiKey,
      model,
      timeoutMs: 52000,
      system: "Eres un editor pedagógico de cobertura completa. Corrige omisiones sin resumir y devuelve únicamente JSON válido.",
      user: buildDocumentRepairPrompt({ sourceText, currentExplanation, missingPoints, subject, topic, audience })
    });
    return res.json({ section: validateDocumentSection(raw, "Sección revisada") });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return res.status(status).json({ error: error instanceof Error ? error.message : "No pude completar los puntos faltantes." });
  }
});

app.get("/api/health", (_req, res) => {
  const { apiKey, model } = getApiConfig();
  res.json({
    ok: true,
    provider: "Cheaper Inference",
    configured: Boolean(apiKey),
    model
  });
});

app.post("/api/chat", async (req, res) => {
  const { apiKey, model } = getApiConfig();

  if (!apiKey) {
    return res.status(500).json({
      error: "Falta CHEAPER_INFERENCE_API_KEY. Copia .env.example como .env y agrega tu clave."
    });
  }

  const { message, subject, topic, mode = "Explicar", history = [], learningProfile = null } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Escribe una pregunta antes de enviar." });
  }

  const messages = [
    { role: "system", content: buildSystemPrompt({ subject, topic, mode, learningProfile }) },
    ...normalizeHistory(history),
    { role: "user", content: message.slice(0, 16000) }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true
      }),
      signal: controller.signal
    });

    if (!upstream.ok) {
      const rawText = await upstream.text();
      clearTimeout(timeout);
      return res.status(upstream.status).json({
        error: friendlyProviderError(upstream.status, rawText)
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const reader = upstream.body?.getReader();
    if (!reader) throw new Error("El proveedor no devolvió un stream legible.");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }

    clearTimeout(timeout);
    res.end();
  } catch (error) {
    clearTimeout(timeout);
    const message = error?.name === "AbortError"
      ? "La respuesta tardó demasiado y se canceló. Intenta otra vez."
      : "No fue posible conectar con Cheaper Inference.";

    if (!res.headersSent) return res.status(502).json({ error: message });
    res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
    res.end();
  }
});


app.post("/api/research", async (req, res) => {
  const { apiKey, model } = getApiConfig();
  if (!apiKey) {
    return res.status(500).json({ error: "Falta CHEAPER_INFERENCE_API_KEY en tu archivo .env." });
  }

  const { query, subject, topic } = req.body || {};
  const cleanQuery = typeof query === "string" ? query.trim().slice(0, 900) : "";
  if (!cleanQuery) return res.status(400).json({ error: "Escribe qué quieres investigar." });

  const searchQuery = cleanQuery;

  const [wikiSources, academicSources] = await Promise.all([
    searchWikipedia(searchQuery),
    searchCrossref(searchQuery)
  ]);

  const sources = [...wikiSources.slice(0, 3), ...academicSources.slice(0, 4)]
    .map((source, index) => ({ ...source, id: `S${index + 1}` }));

  if (!sources.length) {
    return res.status(502).json({
      error: "No encontré fuentes externas disponibles para esta búsqueda. Prueba con una consulta más concreta."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content: "Eres un sintetizador pedagógico basado en fuentes. Debes respetar estrictamente el JSON pedido y nunca fabricar evidencia."
          },
          {
            role: "user",
            content: buildResearchPrompt({ query: cleanQuery, subject, topic, sources })
          }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await upstream.text();
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: friendlyProviderError(upstream.status, rawText) });
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: "Cheaper Inference devolvió una respuesta que no pude interpretar durante la investigación." });
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return res.status(502).json({ error: "El modelo no devolvió una síntesis para las fuentes encontradas." });
    }

    const synthesis = validateResearch(extractJson(content), sources);
    return res.json({
      research: {
        query: cleanQuery,
        ...synthesis,
        sources
      }
    });
  } catch (error) {
    clearTimeout(timeout);
    return res.status(502).json({
      error: error?.name === "AbortError"
        ? "La síntesis de las fuentes tardó demasiado. Intenta de nuevo."
        : "No fue posible sintetizar las fuentes con Cheaper Inference."
    });
  }
});

app.post("/api/quiz", async (req, res) => {
  const { apiKey, model } = getApiConfig();
  if (!apiKey) {
    return res.status(500).json({ error: "Falta CHEAPER_INFERENCE_API_KEY en tu archivo .env." });
  }

  const { subject, topic, history = [], learningProfile = null } = req.body || {};
  if (!topic || typeof topic !== "string") {
    return res.status(400).json({ error: "Define un tema antes de generar el quiz." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content: "Eres un evaluador pedagógico. Tu salida debe respetar estrictamente el formato JSON solicitado por el usuario. No agregues Markdown ni comentarios fuera del JSON."
          },
          {
            role: "user",
            content: buildQuizPrompt({ subject, topic, history, learningProfile })
          }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await upstream.text();
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: friendlyProviderError(upstream.status, rawText) });
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: "Cheaper Inference devolvió una respuesta que no pude interpretar." });
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return res.status(502).json({ error: "El modelo no devolvió contenido para el quiz." });
    }

    try {
      const quiz = validateQuiz(extractJson(content), topic);
      return res.json({ quiz });
    } catch (error) {
      return res.status(502).json({
        error: error instanceof Error ? `No pude validar el quiz generado: ${error.message}` : "No pude validar el quiz generado."
      });
    }
  } catch (error) {
    clearTimeout(timeout);
    return res.status(502).json({
      error: error?.name === "AbortError"
        ? "El quiz tardó demasiado en generarse. Intenta otra vez."
        : "No fue posible conectar con Cheaper Inference para generar el quiz."
    });
  }
});



function getElevenLabsConfig() {
  return {
    apiKey: process.env.ELEVENLABS_API_KEY?.trim(),
    voiceId: process.env.ELEVENLABS_VOICE_ID?.trim(),
    model: process.env.ELEVENLABS_MODEL?.trim() || "eleven_flash_v2_5"
  };
}

function cleanSpeechText(value = "") {
  return String(value)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/\[(S\d+(?:,\s*S\d+)*)\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

app.get("/api/audio-health", (_req, res) => {
  const { apiKey, voiceId, model } = getElevenLabsConfig();
  res.json({
    ok: Boolean(apiKey && voiceId),
    provider: "ElevenLabs",
    configured: Boolean(apiKey && voiceId),
    model,
    outputFormat: "mp3_44100_128"
  });
});

app.post("/api/speech", async (req, res) => {
  const { apiKey, voiceId, model } = getElevenLabsConfig();
  if (!apiKey || !voiceId) {
    return res.status(500).json({
      error: "Faltan ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID en las variables de entorno."
    });
  }

  const text = cleanSpeechText(req.body?.text || "");
  if (!text) return res.status(400).json({ error: "No recibí texto para narrar." });
  if (text.length > 9500) {
    return res.status(400).json({ error: "El texto es demasiado largo para este audio. Reduce el contenido a menos de 9,500 caracteres." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0,
            use_speaker_boost: true,
            speed: 1
          }
        }),
        signal: controller.signal
      }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      let message = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw);
        message = parsed?.detail?.message || parsed?.detail || parsed?.message || message;
      } catch {}
      return res.status(response.status).json({ error: message || `ElevenLabs respondió con el estado ${response.status}.` });
    }

    const audio = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(audio.length));
    return res.status(200).send(audio);
  } catch (error) {
    clearTimeout(timeout);
    return res.status(502).json({
      error: error?.name === "AbortError"
        ? "ElevenLabs tardó demasiado en generar el audio."
        : "No fue posible generar el audio con ElevenLabs."
    });
  }
});

app.post("/api/audio-summary", async (req, res) => {
  const { apiKey, model } = getApiConfig();
  if (!apiKey) return res.status(500).json({ error: "Falta CHEAPER_INFERENCE_API_KEY en tu archivo .env." });

  const { subject, topic, kind = "review", focusText = "", history = [], learningProfile = null } = req.body || {};
  if (!topic || typeof topic !== "string") return res.status(400).json({ error: "Define un tema antes de preparar el audio." });

  try {
    const raw = await requestJsonCompletion({
      apiKey,
      model,
      system: "Eres un guionista pedagógico para audio. Devuelve estrictamente el JSON solicitado y no añadas Markdown fuera de los campos.",
      user: buildAudioPrompt({ subject, topic, kind, focusText, history, learningProfile })
    });
    return res.json({ audio: validateAudio(raw, kind === "explanation") });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return res.status(status).json({
      error: error?.name === "AbortError"
        ? "El guion de audio tardó demasiado en generarse."
        : error instanceof Error ? error.message : "No pude preparar el repaso hablado."
    });
  }
});

app.post("/api/adaptive-plan", async (req, res) => {
  const { apiKey, model } = getApiConfig();
  if (!apiKey) return res.status(500).json({ error: "Falta CHEAPER_INFERENCE_API_KEY en tu archivo .env." });

  const { subject, topic, history = [], learningProfile = null } = req.body || {};
  if (!topic || typeof topic !== "string") return res.status(400).json({ error: "Define un tema antes de crear el plan adaptativo." });

  try {
    const raw = await requestJsonCompletion({
      apiKey,
      model,
      system: "Eres un tutor adaptativo prudente. No inventes desempeño del estudiante. Tu respuesta debe ser únicamente JSON válido con la estructura solicitada.",
      user: buildAdaptivePlanPrompt({ subject, topic, history, learningProfile })
    });
    return res.json({ plan: validateAdaptivePlan(raw, topic) });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return res.status(status).json({
      error: error?.name === "AbortError"
        ? "El plan adaptativo tardó demasiado en generarse."
        : error instanceof Error ? error.message : "No pude crear el plan adaptativo."
    });
  }
});

export default app;
