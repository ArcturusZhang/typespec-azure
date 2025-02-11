import {
  DiagnosticMessages,
  LinterRuleContext,
  Model,
  ModelProperty,
  Operation,
  Program,
  createRule,
  getEffectiveModelType,
  getProperty,
  isErrorType,
  paramMessage,
} from "@typespec/compiler";
import {
  getOperationVerb,
  isBody,
  isBodyRoot,
  isHeader,
  isPathParam,
  isQueryParam,
} from "@typespec/http";

import { getArmResource } from "../resource.js";
import { getSourceModel, isInternalTypeSpec } from "./utils.js";

export const patchOperationsRule = createRule({
  name: "arm-resource-patch",
  severity: "warning",
  description: "Validate ARM PATCH operations.",
  messages: {
    default: "The request body of a PATCH must be a model with a subset of resource properties",
    missingTags: "Resource PATCH must contain the 'tags' property.",
    modelSuperset: paramMessage`Resource PATCH models must be a subset of the resource type. The following properties: [${"name"}] do not exist in resource Model '${"resourceModel"}'.`,
  },
  create(context) {
    return {
      operation: (operation: Operation) => {
        if (!isInternalTypeSpec(context.program, operation)) {
          const verb = getOperationVerb(context.program, operation);
          if (verb === "patch") {
            const resourceType = getResourceModel(context.program, operation);
            if (resourceType) {
              checkPatchModel(context, operation, resourceType);
            }
          }
        }
      },
    };
  },
});

function checkPatchModel(
  context: LinterRuleContext<DiagnosticMessages>,
  operation: Operation,
  resourceType: Model
) {
  const patchModel = getPatchModel(context.program, operation);
  if (patchModel === undefined) {
    context.reportDiagnostic({
      target: operation,
    });
  } else if (
    resourceType.properties.has("tags") &&
    !patchModel.some((p) => p.name === "tags" && p.type.kind === "Model")
  ) {
    context.reportDiagnostic({
      messageId: "missingTags",
      target: operation,
    });
  } else {
    const resourceProperties = resourceType.properties.get("properties");
    const badProperties: ModelProperty[] = [];
    for (const property of patchModel) {
      const sourceModel = getSourceModel(property);
      if (sourceModel === undefined || !getArmResource(context.program, sourceModel)) {
        if (
          !getProperty(resourceType, property.name) &&
          (resourceProperties === undefined ||
            resourceProperties.type.kind !== "Model" ||
            !getProperty(resourceProperties.type, property.name))
        ) {
          badProperties.push(property);
        }
      }
    }
    if (badProperties.length > 0)
      context.reportDiagnostic({
        messageId: "modelSuperset",
        format: {
          name: badProperties.flatMap((t) => t.name).join(", "),
          resourceModel: resourceType.name,
        },
        target: operation,
      });
  }
}

function getResourceModel(program: Program, operation: Operation): Model | undefined {
  const returnType = operation.returnType;
  if (returnType.kind === "Union") {
    for (const variant of returnType.variants.values()) {
      if (!isErrorType(variant.type) && variant.type.kind === "Model") {
        const modelCandidate = getEffectiveModelType(program, variant.type);
        if (getArmResource(program, modelCandidate)) {
          return modelCandidate;
        }
        if (modelCandidate.templateMapper !== undefined) {
          for (const arg of modelCandidate.templateMapper.args) {
            if (arg.kind === "Model" && getArmResource(program, arg)) {
              return arg;
            }
          }
        }
      }
    }
  }

  return undefined;
}

function getPatchModel(program: Program, operation: Operation): ModelProperty[] | undefined {
  const bodyProperties: ModelProperty[] = [];
  const patchModel = getEffectiveModelType(program, operation.parameters);
  for (const [_, property] of patchModel.properties) {
    if (
      isHeader(program, property) ||
      isQueryParam(program, property) ||
      isPathParam(program, property)
    )
      continue;
    if (
      (isBody(program, property) || isBodyRoot(program, property)) &&
      property.type.kind === "Scalar"
    )
      return undefined;
    bodyProperties.push(property);
  }

  if (bodyProperties.length === 0) return undefined;
  if (bodyProperties.length === 1 && bodyProperties[0].type.kind === "Model")
    return [...bodyProperties[0].type.properties.values()];
  return bodyProperties;
}
