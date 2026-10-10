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

export const getTemplateBodyParameterCount = (componentsJson: string) => {
  let components: unknown;
  try {
    components = JSON.parse(componentsJson);
  } catch {
    throw new Error("The synced template components are invalid; sync templates again.");
  }
  if (!Array.isArray(components)) {
    throw new Error("The synced template components are invalid; sync templates again.");
  }

  const body = components.find(
    (component) =>
      typeof component === "object" &&
      component !== null &&
      "type" in component &&
      component.type === "BODY",
  );
  const bodyText =
    typeof body === "object" &&
    body !== null &&
    "text" in body &&
    typeof body.text === "string"
      ? body.text
      : "";
  const positions: number[] = [];
  const placeholders = /\{\{\s*(\d+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = placeholders.exec(bodyText)) !== null) {
    const position = Number(match[1]);
    if (Number.isSafeInteger(position) && position > 0) {
      positions.push(position);
    }
  }
  const uniquePositions = [...new Set(positions)].sort((a, b) => a - b);
  const bodyParameterCount = uniquePositions.length;
  if (
    uniquePositions.some((position, index) => position !== index + 1) ||
    bodyParameterCount > 20
  ) {
    throw new Error(
      "This template uses unsupported body placeholders. Review its approved Meta definition.",
    );
  }
  return bodyParameterCount;
};

export const parseTemplateBodyParameters = (
  raw: string,
  componentsJson: string,
) => {
  let parsedParameters: unknown;
  try {
    parsedParameters = raw ? JSON.parse(raw) : [];
  } catch {
    throw new Error("Template parameters must be a valid JSON string array.");
  }
  if (
    !Array.isArray(parsedParameters) ||
    parsedParameters.length > 20 ||
    parsedParameters.some(
      (parameter) =>
        typeof parameter !== "string" ||
        !parameter.trim() ||
        parameter.length > 1024,
    )
  ) {
    throw new Error(
      'Enter up to 20 non-empty text parameters as a JSON string array, for example ["Alex"].',
    );
  }
  const bodyParameterCount = getTemplateBodyParameterCount(componentsJson);
  if (parsedParameters.length !== bodyParameterCount) {
    throw new Error(
      `This template requires ${bodyParameterCount} body parameter${bodyParameterCount === 1 ? "" : "s"}; provide exactly that many.`,
    );
  }
  return parsedParameters as string[];
};

export const buildWhatsAppTextPayload = (
  recipient: string,
  text: string,
) => ({
  messaging_product: "whatsapp",
  to: recipient.replace(/^\+/, ""),
  type: "text",
  text: { body: text },
});

export const buildWhatsAppTemplatePayload = (
  recipient: string,
  name: string,
  language: string,
  parameters: string[],
) => ({
  messaging_product: "whatsapp",
  to: recipient.replace(/^\+/, ""),
  type: "template",
  template: {
    name,
    language: { code: language },
    ...(parameters.length
      ? {
          components: [
            {
              type: "body",
              parameters: parameters.map((parameter) => ({
                type: "text",
                text: parameter,
              })),
            },
          ],
        }
      : {}),
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
