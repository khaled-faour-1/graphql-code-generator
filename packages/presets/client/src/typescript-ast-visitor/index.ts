import { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { transformSchemaAST } from '@graphql-codegen/schema-ast';

import { TypeScriptPluginConfig } from './config';
import { includeIntrospectionTypesDefinitions } from './graphql-visitor-utils';
import {
  addSyntheticLeadingComment,
  createPrinter,
  createSourceFile,
  EmitHint,
  factory,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ListFormat,
  NewLineKind,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from 'typescript';
import {
  buildScalarsFromConfig,
  convertFactory,
  DeclarationBlock,
  isOneOfInputObjectType,
  ParsedScalarsMap,
  parseEnumValues,
  transformComment,
  transformDirectiveArgumentAndInputFieldMappings,
} from '@graphql-codegen/visitor-plugin-common';
import {
  ASTNode,
  DirectiveNode,
  EnumValueDefinitionNode,
  FieldDefinitionNode,
  GraphQLSchema,
  InputValueDefinitionNode,
  InterfaceTypeDefinitionNode,
  isEnumType,
  Kind,
  NamedTypeNode,
  ObjectTypeDefinitionNode,
  UnionTypeDefinitionNode,
  visit,
} from 'graphql';

export function indent(str: string, count = 1): string {
  return new Array(count).fill('  ').join('') + str;
}

function getDeprecationReason(directive: DirectiveNode): string | void {
  if ((directive.name as any) === 'deprecated') {
    const hasArguments = !!directive.arguments?.length;
    let reason = 'Field no longer supported';
    if (hasArguments) {
      reason = directive.arguments[0].value.kind;
    }
    return reason;
  }
}

function getNodeComment(node: FieldDefinitionNode | EnumValueDefinitionNode | InputValueDefinitionNode): string {
  let commentText: string = node.description as any;
  const deprecationDirective = node.directives?.find(v => v.name.value === 'deprecated');
  if (deprecationDirective) {
    const deprecationReason = getDeprecationReason(deprecationDirective);
    commentText = `${commentText ? `${commentText}\n` : ''}@deprecated ${deprecationReason}`;
  }
  const comment = transformComment(commentText, 1);
  return comment;
}

function getKindsFromAncestors(ancestors: readonly (ASTNode | readonly ASTNode[])[]) {
  if (!ancestors) return [];

  return ancestors
    .map(t => {
      return 'length' in t ? t.map(t => t.kind) : t.kind;
    })
    .filter(Boolean);
}

function MaybeString(ancestors: readonly (ASTNode | readonly ASTNode[])[], children: string) {
  const currentVisitContext = getKindsFromAncestors(ancestors);
  const isInputContext = currentVisitContext.includes(Kind.INPUT_OBJECT_TYPE_DEFINITION);

  return isInputContext ? `InputMaybe<${children}>` : `Maybe<${children}>`;
}

function convertName(
  node: ASTNode | string,
  options?: { useTypesPrefix?: boolean; useTypesSuffix?: boolean; typesPrefix?: string; typesSuffix?: string }
): string {
  const useTypesPrefix = typeof options?.useTypesPrefix === 'boolean' ? options.useTypesPrefix : true;
  const useTypesSuffix = typeof options?.useTypesSuffix === 'boolean' ? options.useTypesSuffix : true;

  let convertedName = '';

  if (useTypesPrefix && options?.typesPrefix) {
    convertedName += options?.typesPrefix;
  }

  // todo?
  const convert = convertFactory({ namingConvention: 'keep' });
  convertedName += convert(node, {
    prefix: options?.typesPrefix,
    suffix: options?.typesSuffix,
  });

  if (useTypesSuffix && options?.typesSuffix) {
    convertedName += options?.typesSuffix;
  }

  return convertedName;
}

function getObjectTypeDeclarationBlock(
  node: ObjectTypeDefinitionNode,
  originalNode: ObjectTypeDefinitionNode,
  config: TypeScriptPluginConfig
): DeclarationBlock {
  const optionalTypename = config.nonOptionalTypename ? '__typename' : '__typename?';
  const allFields = [
    ...(config.skipTypename
      ? []
      : [indent(`${config.immutableTypes ? 'readonly ' : ''}${optionalTypename}: '${node.name}';`)]),
    ...(node.fields || []),
  ] as string[];
  const interfacesNames = originalNode.interfaces ? originalNode.interfaces.map(i => convertName(i)) : [];

  const declarationBlock = new DeclarationBlock({
    enumNameValueSeparator: ' =',
    ignoreExport: config.noExport,
  })
    .export()
    .asKind('type')
    .withName(convertName(node))
    .withComment(node.description as any as string);

  appendInterfacesAndFieldsToBlock(declarationBlock, interfacesNames, allFields);

  return declarationBlock;
}

function buildArgumentsBlock(node: InterfaceTypeDefinitionNode | ObjectTypeDefinitionNode, config: any) {
  const fieldsWithArguments = node.fields?.filter(field => field.arguments && field.arguments.length > 0) || [];
  return fieldsWithArguments
    .map(field => {
      const name =
        node.name.value +
        (config.addUnderscoreToArgsType ? '_' : '') +
        convertName(field, {
          useTypesPrefix: false,
          useTypesSuffix: false,
        }) +
        'Args';

      if (config.onlyEnums) return '';

      return new DeclarationBlock({
        enumNameValueSeparator: ' =',
        ignoreExport: config.noExport,
      })
        .export()
        .asKind('type')
        .withName(convertName(name))
        .withComment(node.description || null).string;
    })
    .join('\n');
}

function appendInterfacesAndFieldsToBlock(block: DeclarationBlock, interfaces: string[], fields: string[]): void {
  block.withContent(mergeInterfaces(interfaces, fields.length > 0));
  block.withBlock(fields.join('\n'));
}

function mergeInterfaces(interfaces: string[], hasOtherFields: boolean): string {
  return interfaces.join(' & ') + (interfaces.length && hasOtherFields ? ' & ' : '');
}

function getTypeForNode(
  node: NamedTypeNode,
  config: TypeScriptPluginConfig,
  schema: GraphQLSchema,
  scalars: ParsedScalarsMap
): string {
  const typename = typeof node.name === 'string' ? node.name : node.name.value;

  // todo
  if (scalars[typename]) {
    return `Scalars['${typename}']`;
  }

  // const { enumValues } = config;
  // if (enumValues && enumValues[typename as keyof TypeScriptPluginConfig['enumValues']]) {
  //   return enumValues[typename as keyof TypeScriptPluginConfig['enumValues']]?.typeIdentifier;
  // }

  const schemaType = schema.getType(typename);

  if (schemaType && isEnumType(schemaType)) {
    return convertName(node, { useTypesPrefix: config.enumPrefix, typesPrefix: config.typesPrefix });
  }

  return convertName(node);
}

function clearOptional(str: string): string {
  if (str.startsWith('Maybe')) {
    return str.replace(/Maybe<(.*?)>$/, '$1');
  }

  return str;
}

function _getDirectiveOverrideType(
  directives: ReadonlyArray<DirectiveNode>,
  config: TypeScriptPluginConfig
): string | null {
  const type = directives
    .map(directive => {
      const directiveName = directive.name as any as string;
      if (config.directiveArgumentAndInputFieldMappings?.[directiveName]) {
        return `DirectiveArgumentAndInputFieldMappings['${directiveName}']`;
      }
      return null;
    })
    .reverse()
    .find(a => !!a);

  return type || null;
}

export const plugin: PluginFunction<TypeScriptPluginConfig, Types.ComplexPluginOutput> = (
  schema,
  documents,
  config
) => {
  const { schema: _schema, ast: gqlDocumentNode } = transformSchemaAST(schema, config);

  const sourceFile = createSourceFile('graphql.ts', '', ScriptTarget.ES2020, false, ScriptKind.TSX);
  const printer = createPrinter({ omitTrailingSemicolon: false, newLine: NewLineKind.CarriageReturnLineFeed });

  const scalarsMap = buildScalarsFromConfig(schema, config);

  type VisitorResultTypeScriptAST = string; // <- TODO
  const visitorResult = visit<VisitorResultTypeScriptAST>(gqlDocumentNode, {
    InputValueDefinition: {
      leave(node, key, parent, _path, ancestors) {
        const originalFieldNode = parent[key] as FieldDefinitionNode;

        const avoidOptionalsConfig = typeof config.avoidOptionals === 'object' ? config.avoidOptionals : {};

        const addOptionalSign =
          !avoidOptionalsConfig.inputValue &&
          (originalFieldNode.type.kind !== Kind.NON_NULL_TYPE ||
            (!avoidOptionalsConfig.defaultValue && node.defaultValue !== undefined));
        const comment = getNodeComment(node as any as InputValueDefinitionNode);

        let type: string = node.type as any as string;
        if (node.directives && config.directiveArgumentAndInputFieldMappings) {
          type = _getDirectiveOverrideType(node.directives, config) || type;
        }

        const readonlyPrefix = config.immutableTypes ? 'readonly ' : '';

        const buildFieldDefinition = (isOneOf = false) => {
          return `${readonlyPrefix}${node.name}${addOptionalSign && !isOneOf ? '?' : ''}: ${
            isOneOf ? clearOptional(type) : type
          };`;
        };

        const realParentDef = ancestors?.[ancestors.length - 1];
        if (realParentDef) {
          const parentType = _schema.getType(realParentDef.name.value);

          if (isOneOfInputObjectType(parentType)) {
            if (originalFieldNode.type.kind === Kind.NON_NULL_TYPE) {
              throw new Error(
                'Fields on an input object type can not be non-nullable. It seems like the schema was not validated.'
              );
            }
            const fieldParts: Array<string> = [];
            for (const fieldName of Object.keys(parentType.getFields())) {
              // Why the heck is node.name a string and not { value: string } at runtime ?!
              if (fieldName === (node.name as any as string)) {
                fieldParts.push(buildFieldDefinition(true));
                continue;
              }
              fieldParts.push(`${readonlyPrefix}${fieldName}?: never;`);
            }
            return comment + indent(`{ ${fieldParts.join(' ')} }`);
          }
        }

        return comment + indent(buildFieldDefinition());
      },
    },
    Name: {
      leave(node, _key, _parent, _path, _ancestors) {
        return node.value;
      },
    },
    UnionTypeDefinition: {
      leave(node, key, parent, _path, _ancestors) {
        if (config.onlyOperationTypes || config.onlyEnums) return '';

        let withFutureAddedValue: string[] = [];
        if (config.futureProofUnions) {
          withFutureAddedValue = [
            config.immutableTypes ? `{ readonly __typename?: "%other" }` : `{ __typename?: "%other" }`,
          ];
        }
        const originalNode = parent[key] as UnionTypeDefinitionNode;
        const possibleTypes = originalNode.types
          .map(t => (scalarsMap[t.name.value] ? `Scalars['${t.name.value}']` : convertName(t)))
          .concat(...withFutureAddedValue)
          .join(' | ');

        return new DeclarationBlock({
          enumNameValueSeparator: ' =',
          ignoreExport: config.noExport,
        })
          .export()
          .asKind('type')
          .withName(convertName(node))
          .withComment(node.description as any as string)
          .withContent(possibleTypes).string;
      },
    },
    InterfaceTypeDefinition: {
      leave(node, key, parent, _path, _ancestors) {
        if (config.onlyOperationTypes || config.onlyEnums) return '';
        const originalNode = parent[key];

        const declarationBlock = new DeclarationBlock({
          enumNameValueSeparator: ' =',
          ignoreExport: config.noExport,
        })
          .export()
          .asKind('interface')
          .withName(convertName(node))
          .withComment(node.description as any as string)
          .withBlock(node.fields.join('\n'));

        return [declarationBlock.string, buildArgumentsBlock(originalNode, config)].filter(f => f).join('\n\n');
      },
    },
    ScalarTypeDefinition: {
      leave(_node, _key, _parent, _path, _ancestors) {
        return '';
      },
    },
    DirectiveDefinition: {
      leave(_node, _key, _parent, _path, _ancestors) {
        return '';
      },
    },
    SchemaDefinition: {
      leave(_node, _key, _parent, _path, _ancestors) {
        return '';
      },
    },
    ObjectTypeDefinition: {
      leave(node, key, parent, _path, _ancestors) {
        if (config.onlyOperationTypes || config.onlyEnums) return '';
        const originalNode = parent[key] as any;

        return [
          getObjectTypeDeclarationBlock(node, originalNode, config).string,
          buildArgumentsBlock(originalNode, config),
        ].join('');
      },
    },
    InputObjectTypeDefinition: {
      leave(node, _key, _parent, _path, _ancestors) {
        if (config.onlyEnums) return '';

        // Why the heck is node.name a string and not { value: string } at runtime ?!
        if (isOneOfInputObjectType(_schema.getType(node.name as unknown as string))) {
          const declarationKind = 'type';
          return new DeclarationBlock({
            enumNameValueSeparator: ' =',
            ignoreExport: config.noExport,
          })
            .export()
            .asKind(declarationKind)
            .withName(convertName(node))
            .withComment(node.description as any as string)
            .withContent(`\n` + node.fields.join('\n  |')).string;
        }

        return new DeclarationBlock({
          enumNameValueSeparator: ' =',
          ignoreExport: config.noExport,
        })
          .export()
          .asKind('type')
          .withName(convertName(node))
          .withComment(node.description as any as string)
          .withBlock(node.fields.join('\n')).string;
      },
    },
    NamedType: {
      leave(node, _key, _parent, _path, ancestors) {
        const isVisitingInputType = getKindsFromAncestors(ancestors).includes(Kind.INPUT_OBJECT_TYPE_DEFINITION);

        let typeToUse = getTypeForNode(node as any as NamedTypeNode, config, _schema, scalarsMap);

        if (!isVisitingInputType && config.fieldWrapperValue && config.wrapFieldDefinitions) {
          typeToUse = `FieldWrapper<${typeToUse}>`;
        }

        return MaybeString(ancestors, typeToUse);
      },
    },
    ListType: {
      leave(node, _key, _parent, _path, ancestors) {
        return MaybeString(ancestors, `Array<${node.type}>`);
      },
    },
    NonNullType: {
      leave(node, _key, _parent, _path, _ancestors) {
        if (node.type.startsWith('Maybe')) {
          return node.type.replace(/Maybe<(.*?)>$/, '$1');
        }
        if (node.type.startsWith('InputMaybe')) {
          return node.type.replace(/InputMaybe<(.*?)>$/, '$1');
        }

        return node.type;
      },
    },
    FieldDefinition: {
      leave(node, key, parent, _path, _ancestors) {
        const typeString = config.wrapFieldDefinitions
          ? `EntireFieldWrapper<${node.type}>`
          : (node.type as any as string);
        // TODO
        const originalFieldNode = (parent as any)[key as number];
        const addOptionalSign =
          !(config.avoidOptionals as any)?.field && originalFieldNode.type.kind !== Kind.NON_NULL_TYPE;
        const comment = getNodeComment(node as any as FieldDefinitionNode);

        return (
          comment +
          indent(`${config.immutableTypes ? 'readonly ' : ''}${node.name}${addOptionalSign ? '?' : ''}: ${typeString};`)
        );
      },
    },
  });
  const introspectionDefinitions = includeIntrospectionTypesDefinitions(_schema, documents, config);

  // Scalars
  const scalars_ = Object.keys(scalarsMap).map(scalarName => {
    const scalarValue = scalarsMap[scalarName].type;
    const scalarType = schema.getType(scalarName);
    const comment = scalarType?.astNode && scalarType.description ? transformComment(scalarType.description, 1) : '';

    const propertySignature = factory.createPropertySignature(
      undefined,
      scalarName,
      undefined,
      factory.createTypeReferenceNode(scalarValue)
    );

    if (comment) {
      addSyntheticLeadingComment(propertySignature, SyntaxKind.MultiLineCommentTrivia, comment, true);
    }

    return propertySignature;
  });

  const scalarsTypeAliasDeclaration = factory.createTypeAliasDeclaration(
    [factory.createModifier(SyntaxKind.ExportKeyword)],
    'Scalars',
    undefined,
    factory.createTypeLiteralNode(scalars_)
  );

  addSyntheticLeadingComment(
    scalarsTypeAliasDeclaration,
    SyntaxKind.MultiLineCommentTrivia,
    // TODO: that's an ugly workaround
    '* All built-in and custom scalars, mapped to their actual values ',
    true
  );

  const scalarsTypeDeclaration = printer.printNode(EmitHint.Unspecified, scalarsTypeAliasDeclaration, sourceFile);

  const directiveEntries = Object.entries(config.directiveArgumentAndInputFieldMappings || {});
  const directives = directiveEntries.map(([directiveName, directiveValue]) => {
    const directiveType = schema.getDirective(directiveName);
    const comment =
      directiveType?.astNode && directiveType.description ? transformComment(directiveType.description, 1) : '';

    const propertySignature = factory.createPropertySignature(
      undefined,
      directiveName,
      undefined,
      factory.createTypeReferenceNode(directiveValue)
    );

    if (comment) {
      addSyntheticLeadingComment(propertySignature, SyntaxKind.MultiLineCommentTrivia, comment, true);
    }

    return propertySignature;
  });

  let directivesDeclaration = '';
  if (directives.length) {
    const directivestTypeAliasDeclaration = factory.createTypeAliasDeclaration(
      undefined,
      'DirectiveArgumentAndInputFieldMappings',
      undefined,
      factory.createTypeLiteralNode(directives)
    );

    addSyntheticLeadingComment(
      directivestTypeAliasDeclaration,
      SyntaxKind.SingleLineCommentTrivia,
      'Type overrides using directives',
      true
    );

    directivesDeclaration = printer.printNode(EmitHint.Unspecified, directivestTypeAliasDeclaration, sourceFile);
  }

  const parsedEnumValues = parseEnumValues({
    schema,
    mapOrStr: config.enumValues!,
    ignoreEnumValuesFromSchema: config.ignoreEnumValuesFromSchema,
  });

  const enumImportDeclarations = Object.keys(parsedEnumValues).flatMap(
    (enumName): Array<ImportDeclaration | ImportEqualsDeclaration> => {
      const mappedValue = parsedEnumValues[enumName];

      if (!mappedValue.sourceFile) {
        return [];
      }

      if (mappedValue.isDefault) {
        const importDeclaration = factory.createImportDeclaration(
          undefined,
          factory.createImportClause(
            config.useTypeImports ?? false,
            undefined,
            factory.createNamedImports([
              factory.createImportSpecifier(
                false,
                factory.createIdentifier('default'),
                factory.createIdentifier(mappedValue.typeIdentifier)
              ),
            ])
          ),
          factory.createStringLiteral(mappedValue.sourceFile)
        );

        return [importDeclaration];
      }

      if (mappedValue.importIdentifier !== mappedValue.sourceIdentifier) {
        // use namespace import to dereference nested enum
        // { enumValues: { MyEnum: './my-file#NS.NestedEnum' } }
        const importDeclaration = factory.createImportDeclaration(
          undefined,
          factory.createImportClause(
            config.useTypeImports ?? false,
            factory.createIdentifier(mappedValue.importIdentifier || mappedValue.sourceIdentifier || ''),
            undefined
          ),
          factory.createStringLiteral(mappedValue.sourceFile)
        );

        const importEqualsDeclaration = factory.createImportEqualsDeclaration(
          undefined,
          false,
          factory.createIdentifier(mappedValue.typeIdentifier),
          factory.createIdentifier(mappedValue.sourceIdentifier!)
        );

        return [importDeclaration, importEqualsDeclaration];
      }

      if (mappedValue.sourceIdentifier !== mappedValue.typeIdentifier) {
        return [
          factory.createImportDeclaration(
            undefined,
            factory.createImportClause(
              config.useTypeImports ?? false,
              undefined,
              factory.createNamedImports([
                factory.createImportSpecifier(
                  false,
                  factory.createIdentifier(mappedValue.sourceIdentifier!),
                  factory.createIdentifier(mappedValue.typeIdentifier)
                ),
              ])
            ),
            factory.createStringLiteral(mappedValue.sourceFile)
          ),
        ];
      }

      return [
        factory.createImportDeclaration(
          undefined,
          factory.createImportClause(
            config.useTypeImports ?? false,
            factory.createIdentifier(mappedValue.importIdentifier || mappedValue.sourceIdentifier || ''),
            undefined
          ),
          factory.createStringLiteral(mappedValue.sourceFile)
        ),
      ];
    }
  );

  const importDeclarationsAsNode = factory.createNodeArray(enumImportDeclarations.filter(Boolean));
  const enumImportsDeclaration = printer.printList(ListFormat.None, importDeclarationsAsNode, sourceFile);

  const directiveArgumentAndInputFieldMappings = transformDirectiveArgumentAndInputFieldMappings(
    config.directiveArgumentAndInputFieldMappings ?? {},
    config.directiveArgumentAndInputFieldMappingTypeSuffix
  );

  const directiveArgumentAndInputImports = Object.entries(directiveArgumentAndInputFieldMappings).flatMap(
    ([_, directiveValue]) => {
      if (directiveValue.isExternal) {
        if (directiveValue.default) {
          return factory.createImportDeclaration(
            undefined,
            factory.createImportClause(
              config.useTypeImports ?? false,
              undefined,
              factory.createNamedImports([
                factory.createImportSpecifier(
                  false,
                  factory.createIdentifier('default'),
                  factory.createIdentifier(directiveValue.import)
                ),
              ])
            ),
            factory.createStringLiteral(directiveValue.source)
          );
        }
        return factory.createImportDeclaration(
          undefined,
          factory.createImportClause(
            config.useTypeImports ?? false,
            factory.createIdentifier(directiveValue.import),
            undefined
          ),
          factory.createStringLiteral(directiveValue.source)
        );
      }

      return [];
    }
  );

  const directiveArgumentAndInputImportsAsNode = factory.createNodeArray(
    directiveArgumentAndInputImports.filter(Boolean)
  );
  const directiveImportsDeclaration = printer.printList(
    ListFormat.None,
    directiveArgumentAndInputImportsAsNode,
    sourceFile
  );

  return {
    // tsAST: TODO,
    prepend: [
      enumImportsDeclaration,
      directiveImportsDeclaration,
      ...getScalarsImports(scalarsMap, config.useTypeImports ?? false),
      ...getWrapperDefinitions(config),
    ].filter(Boolean),
    content: [
      // todo: yes, that sucks
      scalarsTypeDeclaration.replace(/\s{4}(?=\w)/g, '  ') + '\n',
      directivesDeclaration,
      ...visitorResult.definitions,
      ...introspectionDefinitions,
    ]
      .filter(Boolean)
      .join('\n'),
  };
};

function getScalarsImports(scalars: ParsedScalarsMap, useTypeImports: boolean): string[] {
  return Object.keys(scalars)
    .map(enumName => {
      const mappedValue = scalars[enumName];

      if (mappedValue.isExternal) {
        return buildTypeImport(mappedValue.import, mappedValue.source, mappedValue.default, useTypeImports);
      }

      return '';
    })
    .filter(Boolean);
}

function buildTypeImport(identifier: string, source: string, asDefault = false, useTypeImports: boolean): string {
  if (asDefault) {
    if (useTypeImports) {
      return `import type { default as ${identifier} } from '${source}';`;
    }
    return `import ${identifier} from '${source}';`;
  }
  return `import${useTypeImports ? ' type' : ''} { ${identifier} } from '${source}';`;
}

export const EXACT_SIGNATURE = `type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };`;
export const MAKE_OPTIONAL_SIGNATURE = `type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };`;
export const MAKE_MAYBE_SIGNATURE = `type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };`;

function getWrapperDefinitions(config: TypeScriptPluginConfig): string[] {
  if (config.onlyEnums) return [];
  let exportPrefix = 'export ';
  if (config.noExport) {
    exportPrefix = '';
  }

  const exactDefinition = `${exportPrefix}${EXACT_SIGNATURE}`;

  const optionalDefinition = `${exportPrefix}${MAKE_OPTIONAL_SIGNATURE}`;

  const maybeDefinition = `${exportPrefix}${MAKE_MAYBE_SIGNATURE}`;

  const maybeValue = `${exportPrefix}type Maybe<T> = ${config.maybeValue || 'T | null'};`;

  const inputMaybeValue = `${exportPrefix}type InputMaybe<T> = ${config.inputMaybeValue || 'Maybe<T>'};`;

  const definitions: string[] = [maybeValue, inputMaybeValue, exactDefinition, optionalDefinition, maybeDefinition];

  if (config.wrapFieldDefinitions) {
    const fieldWrapperDefinition = `${exportPrefix}type FieldWrapper<T> = ${config.fieldWrapperValue};`;
    definitions.push(fieldWrapperDefinition);
  }
  if (config.wrapEntireFieldDefinitions) {
    const entireFieldWrapperDefinition = `${exportPrefix}type EntireFieldWrapper<T> = ${
      config.entireFieldWrapperValue || 'T'
    };`;
    definitions.push(entireFieldWrapperDefinition);
  }

  return definitions;
}
