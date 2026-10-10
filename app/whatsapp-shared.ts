export const isInsideCustomerServiceWindow = (
  lastInboundAt: Date | null,
  now = new Date(),
) =>
  lastInboundAt !== null &&
  lastInboundAt.getTime() <= now.getTime() &&
  now.getTime() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;

export const normalizeE164Phone = (value: string) => {
  const candidate = value.trim().replace(/[().\s-]/g, "");
  if (!/^\+?\d{7,15}$/.test(candidate)) return null;
  const digits = candidate.replace(/^\+/, "");
  if (digits.startsWith("0")) return null;
  return `+${digits}`;
};

export type TemplateVariable = {
  key: string;
  label: string;
};

export type WhatsAppTemplateRequirements = {
  header:
    | { format: "TEXT"; text: string; variables: TemplateVariable[] }
    | { format: "IMAGE"; variables: [] }
    | null;
  bodyText: string;
  bodyVariables: TemplateVariable[];
  footerText: string;
  buttons: {
    index: number;
    label: string;
    url: string;
    variables: TemplateVariable[];
  }[];
  previewButtons: { label: string; type: string; url: string }[];
  unsupported: string | null;
};

export type WhatsAppTemplateInput = {
  body?: string[];
  header?: {
    format: "TEXT" | "IMAGE";
    values?: string[];
    value?: string;
    mediaType?: "url" | "id";
  };
  buttons?: Record<string, string[]>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getVariables = (text: string): TemplateVariable[] => {
  const matches = [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)];
  const unmatchedText = text.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, "");
  if (unmatchedText.includes("{{") || unmatchedText.includes("}}")) {
    throw new Error("This template contains a malformed placeholder.");
  }
  const tokens = matches.map(
    (match) => match[1],
  );
  const numeric = tokens.every((token) => /^\d+$/.test(token));
  const named = tokens.every((token) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(token));
  if (tokens.length > 0 && !numeric && !named) {
    throw new Error("This template mixes unsupported placeholder formats.");
  }
  const keys = numeric
    ? [...new Set(tokens.map(Number))].sort((a, b) => a - b).map(String)
    : [...new Set(tokens)];
  if (
    keys.length > 20 ||
    (numeric && keys.some((key, index) => Number(key) !== index + 1))
  ) {
    throw new Error("This template uses unsupported or non-sequential placeholders.");
  }
  return keys.map((key) => ({
    key,
    label: numeric ? `Parameter ${key}` : key,
  }));
};

export const getWhatsAppTemplateRequirements = (
  componentsJson: string,
): WhatsAppTemplateRequirements => {
  let components: unknown;
  try {
    components = JSON.parse(componentsJson);
  } catch {
    throw new Error("The synced template components are invalid; sync templates again.");
  }
  if (!Array.isArray(components)) {
    throw new Error("The synced template components are invalid; sync templates again.");
  }
  let header: WhatsAppTemplateRequirements["header"] = null;
  let bodyText = "";
  let bodyVariables: TemplateVariable[] = [];
  let footerText = "";
  const buttons: WhatsAppTemplateRequirements["buttons"] = [];
  const previewButtons: WhatsAppTemplateRequirements["previewButtons"] = [];
  let unsupported: string | null = null;
  const seenComponents = new Set<string>();

  for (const [componentIndex, component] of components.entries()) {
    if (!isRecord(component) || typeof component.type !== "string") {
      throw new Error("The synced template contains an invalid component.");
    }
    const type = component.type.toUpperCase();
    if (
      ["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(type) &&
      seenComponents.has(type)
    ) {
      throw new Error(`The synced template contains multiple ${type} components.`);
    }
    seenComponents.add(type);
    if (type === "HEADER") {
      if (header) throw new Error("This template has multiple headers.");
      const format =
        typeof component.format === "string" ? component.format.toUpperCase() : "";
      if (format === "TEXT") {
        if (typeof component.text !== "string") {
          throw new Error("The synced text header is missing its template text.");
        }
        const text = component.text;
        header = { format: "TEXT", text, variables: getVariables(text) };
      } else if (format === "IMAGE") {
        header = { format: "IMAGE", variables: [] };
      } else {
        unsupported ??= `The ${format || "unknown"} header type is not supported for sending.`;
      }
    } else if (type === "BODY") {
      if (typeof component.text !== "string") {
        throw new Error("The synced template body is missing its template text.");
      }
      bodyText = component.text;
      bodyVariables = getVariables(bodyText);
    } else if (type === "FOOTER") {
      if (typeof component.text !== "string") {
        throw new Error("The synced template footer is missing its template text.");
      }
      footerText = component.text;
      if (/\{\{|\}\}/.test(footerText)) {
        unsupported ??= "Template footer parameters are not supported.";
      }
    } else if (type === "BUTTONS") {
      if (!Array.isArray(component.buttons)) {
        throw new Error("The synced template has an invalid buttons component.");
      }
      for (const [index, button] of component.buttons.entries()) {
        if (!isRecord(button) || typeof button.type !== "string") {
          throw new Error("The synced template contains an invalid button.");
        }
        const buttonType = button.type.toUpperCase();
        if (
          (buttonType === "URL" && typeof button.url !== "string") ||
          (buttonType === "PHONE_NUMBER" &&
            typeof button.phone_number !== "string") ||
          (buttonType === "QUICK_REPLY" && typeof button.text !== "string")
        ) {
          throw new Error(`The synced ${buttonType} button is missing required fields.`);
        }
        const label =
          typeof button.text === "string" ? button.text : `Button ${index + 1}`;
        const url = typeof button.url === "string" ? button.url : "";
        const variables = buttonType === "URL" ? getVariables(url) : [];
        const otherButtonText = [
          url,
          typeof button.phone_number === "string" ? button.phone_number : "",
          typeof button.example === "string" ? button.example : "",
        ].join(" ");
        if (
          buttonType !== "URL" &&
          buttonType !== "QUICK_REPLY" &&
          buttonType !== "PHONE_NUMBER"
        ) {
          unsupported ??= `The ${buttonType} button is not supported for sending.`;
        } else if (
          buttonType !== "URL" &&
          /\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(otherButtonText)
        ) {
          unsupported ??= `Dynamic ${buttonType} button parameters are not supported.`;
        }
        if (variables.length) {
          buttons.push({ index, label, url, variables });
        }
        previewButtons.push({
          label,
          type: buttonType,
          url: variables.length ? substitute(url, variables, variables.map((item) => `{{${item.key}}}`)) : url,
        });
      }
    } else {
      unsupported ??= `The ${type} component at position ${componentIndex + 1} is not supported.`;
    }
  }

  return {
    header,
    bodyText,
    bodyVariables,
    footerText,
    buttons,
    previewButtons,
    unsupported,
  };
};

export const getTemplateBodyParameterCount = (componentsJson: string) =>
  getWhatsAppTemplateRequirements(componentsJson).bodyVariables.length;

export const parseTemplateBodyParameters = (
  raw: string,
  componentsJson: string,
) => {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    throw new Error("Template parameters must be a valid JSON string array.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Template parameters must be a valid JSON string array.");
  }
  const expected = getTemplateBodyParameterCount(componentsJson);
  if (
    parsed.length !== expected ||
    parsed.some(
      (value) =>
        typeof value !== "string" || !value.trim() || value.length > 1024,
    )
  ) {
    throw new Error(
      `This template requires ${expected} non-empty body parameter${expected === 1 ? "" : "s"} of at most 1,024 characters.`,
    );
  }
  return parsed as string[];
};

const validateValues = (
  values: unknown,
  variables: TemplateVariable[],
  section: string,
) => {
  if (!Array.isArray(values) || values.length !== variables.length) {
    throw new Error(
      `${section} requires exactly ${variables.length} parameter${variables.length === 1 ? "" : "s"}.`,
    );
  }
  return values.map((value, index) => {
    if (typeof value !== "string" || !value.trim() || value.length > 1024) {
      throw new Error(
        `${section} ${variables[index].label} must be non-empty and at most 1,024 characters.`,
      );
    }
    return value;
  });
};

const substitute = (
  text: string,
  variables: TemplateVariable[],
  values: string[],
) =>
  text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (placeholder, key: string) => {
    const index = variables.findIndex((variable) => variable.key === key);
    return index >= 0 ? values[index] : placeholder;
  });

export const parseWhatsAppTemplateInput = (
  raw: string,
  componentsJson: string,
) => {
  let input: unknown;
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Template inputs must be valid JSON.");
  }
  if (!isRecord(input)) throw new Error("Template inputs must be an object.");
  const requirements = getWhatsAppTemplateRequirements(componentsJson);
  if (requirements.unsupported) throw new Error(requirements.unsupported);

  const parameters: Record<string, unknown>[] = [];
  let previewHeader = "";
  let previewBody = requirements.bodyText;
  if (
    requirements.header?.format === "TEXT" &&
    requirements.header.variables.length > 0
  ) {
    const headerInput = isRecord(input.header) ? input.header : {};
    const values = validateValues(
      headerInput.values,
      requirements.header.variables,
      "Text header",
    );
    parameters.push({
      type: "header",
      parameters: values.map((text, index) => ({
        type: "text",
        text,
        ...(requirements.header?.variables[index].label.startsWith("Parameter ")
          ? {}
          : { parameter_name: requirements.header?.variables[index].key }),
      })),
    });
    previewHeader = substitute(
      requirements.header.text,
      requirements.header.variables,
      values,
    );
  } else if (requirements.header?.format === "TEXT") {
    previewHeader = requirements.header.text;
  } else if (requirements.header?.format === "IMAGE") {
    const headerInput = isRecord(input.header) ? input.header : {};
    const value = typeof headerInput.value === "string" ? headerInput.value.trim() : "";
    if (headerInput.mediaType === "url") {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error("Enter a valid HTTPS image URL or choose a media ID.");
      }
      if (url.protocol !== "https:" || value.length > 2048) {
        throw new Error("The image URL must use HTTPS and be at most 2,048 characters.");
      }
      parameters.push({
        type: "header",
        parameters: [{ type: "image", image: { link: url.toString() } }],
      });
      previewHeader = `Image: ${url.toString()}`;
    } else if (headerInput.mediaType === "id" && /^\d{5,30}$/.test(value)) {
      parameters.push({
        type: "header",
        parameters: [{ type: "image", image: { id: value } }],
      });
      previewHeader = `Image media ID: ${value}`;
    } else {
      throw new Error("Enter a valid HTTPS image URL or a numeric WhatsApp media ID.");
    }
  }

  if (requirements.bodyVariables.length > 0) {
    const values = validateValues(
      input.body,
      requirements.bodyVariables,
      "Template body",
    );
    parameters.push({
      type: "body",
      parameters: values.map((text, index) => ({
        type: "text",
        text,
        ...(requirements.bodyVariables[index].label.startsWith("Parameter ")
          ? {}
          : { parameter_name: requirements.bodyVariables[index].key }),
      })),
    });
    previewBody = substitute(
      requirements.bodyText,
      requirements.bodyVariables,
      values,
    );
  }

  const buttonValues = new Map<number, string[]>();
  for (const button of requirements.buttons) {
    const values = validateValues(
      input.buttons && isRecord(input.buttons)
        ? input.buttons[String(button.index)]
        : undefined,
      button.variables,
      `Button "${button.label}"`,
    );
    parameters.push({
      type: "button",
      sub_type: "url",
      index: String(button.index),
      parameters: values.map((text) => ({ type: "text", text })),
    });
    buttonValues.set(button.index, values);
  }
  const previewButtons = requirements.previewButtons
    .map((button, index) => {
      const dynamic = requirements.buttons.find((item) => item.index === index);
      const values = buttonValues.get(index);
      const url =
        dynamic && values
          ? substitute(dynamic.url, dynamic.variables, values)
          : button.url;
      return `${button.label}${url ? `: ${url}` : ""}`;
    })
    .filter(Boolean)
    .join("\n");

  return {
    components: parameters,
    preview: [previewHeader, previewBody, requirements.footerText, previewButtons]
      .filter(Boolean)
      .join("\n"),
  };
};

export const buildWhatsAppTextPayload = (recipient: string, text: string) => ({
  messaging_product: "whatsapp",
  to: recipient.replace(/^\+/, ""),
  type: "text",
  text: { body: text },
});

export const buildWhatsAppTemplatePayload = (
  recipient: string,
  name: string,
  language: string,
  components: Record<string, unknown>[],
) => ({
  messaging_product: "whatsapp",
  to: recipient.replace(/^\+/, ""),
  type: "template",
  template: {
    name,
    language: { code: language },
    ...(components.length ? { components } : {}),
  },
});

export const getWhatsAppStatusTransition = (status: string) => {
  switch (status) {
    case "sent":
      return { status: "SENT", allowed: ["PENDING"] as const };
    case "delivered":
      return { status: "DELIVERED", allowed: ["PENDING", "SENT"] as const };
    case "read":
      return {
        status: "READ",
        allowed: ["PENDING", "SENT", "DELIVERED"] as const,
      };
    case "failed":
      return { status: "FAILED", allowed: ["PENDING", "SENT"] as const };
    default:
      return null;
  }
};
