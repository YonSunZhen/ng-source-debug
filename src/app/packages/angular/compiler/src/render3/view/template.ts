/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {flatten, sanitizeIdentifier} from '../../compile_metadata';
import {BindingForm, BuiltinFunctionCall, LocalResolver, convertActionBinding, convertPropertyBinding} from '../../compiler_util/expression_converter';
import {ConstantPool} from '../../constant_pool';
import * as core from '../../core';
import {AST, AstMemoryEfficientTransformer, BindingPipe, BindingType, FunctionCall, ImplicitReceiver, Interpolation, LiteralArray, LiteralMap, LiteralPrimitive, PropertyRead} from '../../expression_parser/ast';
import {Lexer} from '../../expression_parser/lexer';
import {Parser} from '../../expression_parser/parser';
import * as html from '../../ml_parser/ast';
import {HtmlParser} from '../../ml_parser/html_parser';
import {WhitespaceVisitor} from '../../ml_parser/html_whitespaces';
import {DEFAULT_INTERPOLATION_CONFIG} from '../../ml_parser/interpolation_config';
import {isNgContainer as checkIsNgContainer, splitNsName} from '../../ml_parser/tags';
import * as o from '../../output/output_ast';
import {ParseError, ParseSourceSpan} from '../../parse_util';
import {DomElementSchemaRegistry} from '../../schema/dom_element_schema_registry';
import {CssSelector, SelectorMatcher} from '../../selector';
import {BindingParser} from '../../template_parser/binding_parser';
import {error} from '../../util';
import * as t from '../r3_ast';
import {Identifiers as R3} from '../r3_identifiers';
import {htmlAstToRender3Ast} from '../r3_template_transform';

import {R3QueryMetadata} from './api';
import {parseStyle} from './styling';
import {CONTEXT_NAME, I18N_ATTR, I18N_ATTR_PREFIX, ID_SEPARATOR, IMPLICIT_REFERENCE, MEANING_SEPARATOR, NON_BINDABLE_ATTR, REFERENCE_PREFIX, RENDER_FLAGS, asLiteral, invalid, isI18NAttribute, mapToExpression, trimTrailingNulls, unsupported} from './util';

function mapBindingToInstruction(type: BindingType): o.ExternalReference|undefined {
  switch (type) {
    case BindingType.Property:
      return R3.elementProperty;
    case BindingType.Class:
      return R3.elementClassProp;
    case BindingType.Attribute:
    case BindingType.Animation:
      return R3.elementAttribute;
    default:
      return undefined;
  }
}

//  if (rf & flags) { .. }
export function renderFlagCheckIfStmt(
    flags: core.RenderFlags, statements: o.Statement[]): o.IfStmt {
  return o.ifStmt(o.variable(RENDER_FLAGS).bitwiseAnd(o.literal(flags), null, false), statements);
}

export class TemplateDefinitionBuilder implements t.Visitor<void>, LocalResolver {
  private _dataIndex = 0;
  private _bindingContext = 0;
  private _prefixCode: o.Statement[] = [];
  /**
   * List of callbacks to generate creation mode instructions. We store them here as we process
   * the template so bindings in listeners are resolved only once all nodes have been visited.
   * This ensures all local refs and context variables are available for matching.
   */
  private _creationCodeFns: (() => o.Statement)[] = [];
  /**
   * List of callbacks to generate update mode instructions. We store them here as we process
   * the template so bindings are resolved only once all nodes have been visited. This ensures
   * all local refs and context variables are available for matching.
   */
  private _updateCodeFns: (() => o.Statement)[] = [];
  /** Temporary variable declarations generated from visiting pipes, literals, etc. */
  private _tempVariables: o.Statement[] = [];
  /**
   * List of callbacks to build nested templates. Nested templates must not be visited until
   * after the parent template has finished visiting all of its nodes. This ensures that all
   * local ref bindings in nested templates are able to find local ref values if the refs
   * are defined after the template declaration.
   */
  private _nestedTemplateFns: (() => void)[] = [];
  /**
   * This scope contains local variables declared in the update mode block of the template.
   * (e.g. refs and context vars in bindings)
   */
  private _bindingScope: BindingScope;
  private _valueConverter: ValueConverter;
  private _unsupported = unsupported;

  // Whether we are inside a translatable element (`<p i18n>... somewhere here ... </p>)
  private _inI18nSection: boolean = false;
  private _i18nSectionIndex = -1;
  // Maps of placeholder to node indexes for each of the i18n section
  private _phToNodeIdxes: {[phName: string]: number[]}[] = [{}];

  // Number of slots to reserve for pureFunctions
  private _pureFunctionSlots = 0;

  // Number of binding slots
  private _bindingSlots = 0;

  private fileBasedI18nSuffix: string;

  constructor(
      private constantPool: ConstantPool, parentBindingScope: BindingScope, private level = 0,
      private contextName: string|null, private templateName: string|null,
      private viewQueries: R3QueryMetadata[], private directiveMatcher: SelectorMatcher|null,
      private directives: Set<o.Expression>, private pipeTypeByName: Map<string, o.Expression>,
      private pipes: Set<o.Expression>, private _namespace: o.ExternalReference,
      private relativeContextFilePath: string) {
    // view queries can take up space in data and allocation happens earlier (in the "viewQuery"
    // function)
    this._dataIndex = viewQueries.length;

    this._bindingScope = parentBindingScope.nestedScope(level);

    // Turn the relative context file path into an identifier by replacing non-alphanumeric
    // characters with underscores.
    this.fileBasedI18nSuffix = relativeContextFilePath.replace(/[^A-Za-z0-9]/g, '_') + '_';

    this._valueConverter = new ValueConverter(
        constantPool, () => this.allocateDataSlot(),
        (numSlots: number) => this.allocatePureFunctionSlots(numSlots),
        (name, localName, slot, value: o.ReadVarExpr) => {
          const pipeType = pipeTypeByName.get(name);
          if (pipeType) {
            this.pipes.add(pipeType);
          }
          this._bindingScope.set(this.level, localName, value);
          this.creationInstruction(null, R3.pipe, [o.literal(slot), o.literal(name)]);
        });
  }

  registerContextVariables(variable: t.Variable) {
    const scopedName = this._bindingScope.freshReferenceName();
    const retrievalLevel = this.level;
    const lhs = o.variable(variable.name + scopedName);
    this._bindingScope.set(
        retrievalLevel, variable.name, lhs, DeclarationPriority.CONTEXT,
        (scope: BindingScope, relativeLevel: number) => {
          let rhs: o.Expression;
          if (scope.bindingLevel === retrievalLevel) {
            // e.g. ctx
            rhs = o.variable(CONTEXT_NAME);
          } else {
            const sharedCtxVar = scope.getSharedContextName(retrievalLevel);
            // e.g. ctx_r0   OR  x(2);
            rhs = sharedCtxVar ? sharedCtxVar : generateNextContextExpr(relativeLevel);
          }
          // e.g. const $item$ = x(2).$implicit;
          return [lhs.set(rhs.prop(variable.value || IMPLICIT_REFERENCE)).toConstDecl()];
        });
  }

  buildTemplateFunction(
      nodes: t.Node[], variables: t.Variable[], hasNgContent: boolean = false,
      ngContentSelectors: string[] = []): o.FunctionExpr {
    if (this._namespace !== R3.namespaceHTML) {
      this.creationInstruction(null, this._namespace);
    }

    // Create variable bindings
    variables.forEach(v => this.registerContextVariables(v));

    // Output a `ProjectionDef` instruction when some `<ng-content>` are present
    if (hasNgContent) {
      const parameters: o.Expression[] = [];

      // Only selectors with a non-default value are generated
      if (ngContentSelectors.length > 1) {
        const r3Selectors = ngContentSelectors.map(s => core.parseSelectorToR3Selector(s));
        // `projectionDef` needs both the parsed and raw value of the selectors
        const parsed = this.constantPool.getConstLiteral(asLiteral(r3Selectors), true);
        const unParsed = this.constantPool.getConstLiteral(asLiteral(ngContentSelectors), true);
        parameters.push(parsed, unParsed);
      }

      this.creationInstruction(null, R3.projectionDef, parameters);
    }

    // This is the initial pass through the nodes of this template. In this pass, we
    // queue all creation mode and update mode instructions for generation in the second
    // pass. It's necessary to separate the passes to ensure local refs are defined before
    // resolving bindings. We also count bindings in this pass as we walk bound expressions.
    t.visitAll(this, nodes);

    // Add total binding count to pure function count so pure function instructions are
    // generated with the correct slot offset when update instructions are processed.
    this._pureFunctionSlots += this._bindingSlots;

    // Pipes are walked in the first pass (to enqueue `pipe()` creation instructions and
    // `pipeBind` update instructions), so we have to update the slot offsets manually
    // to account for bindings.
    this._valueConverter.updatePipeSlotOffsets(this._bindingSlots);

    // Nested templates must be processed before creation instructions so template()
    // instructions can be generated with the correct internal const count.
    this._nestedTemplateFns.forEach(buildTemplateFn => buildTemplateFn());

    // Generate all the creation mode instructions (e.g. resolve bindings in listeners)
    const creationStatements = this._creationCodeFns.map((fn: () => o.Statement) => fn());

    // Generate all the update mode instructions (e.g. resolve property or text bindings)
    const updateStatements = this._updateCodeFns.map((fn: () => o.Statement) => fn());

    //  Variable declaration must occur after binding resolution so we can generate context
    //  instructions that build on each other. e.g. const b = x().$implicit(); const b = x();
    const creationVariables = this._bindingScope.viewSnapshotStatements();
    const updateVariables = this._bindingScope.variableDeclarations().concat(this._tempVariables);

    const creationBlock = creationStatements.length > 0 ?
        [renderFlagCheckIfStmt(
            core.RenderFlags.Create, creationVariables.concat(creationStatements))] :
        [];

    const updateBlock = updateStatements.length > 0 ?
        [renderFlagCheckIfStmt(core.RenderFlags.Update, updateVariables.concat(updateStatements))] :
        [];

    // Generate maps of placeholder name to node indexes
    // TODO(vicb): This is a WIP, not fully supported yet
    for (const phToNodeIdx of this._phToNodeIdxes) {
      if (Object.keys(phToNodeIdx).length > 0) {
        const scopedName = this._bindingScope.freshReferenceName();
        const phMap = o.variable(scopedName).set(mapToExpression(phToNodeIdx, true)).toConstDecl();

        this._prefixCode.push(phMap);
      }
    }

    return o.fn(
        // i.e. (rf: RenderFlags, ctx: any)
        [new o.FnParam(RENDER_FLAGS, o.NUMBER_TYPE), new o.FnParam(CONTEXT_NAME, null)],
        [
          // Temporary variable declarations for query refresh (i.e. let _t: any;)
          ...this._prefixCode,
          // Creating mode (i.e. if (rf & RenderFlags.Create) { ... })
          ...creationBlock,
          // Binding and refresh mode (i.e. if (rf & RenderFlags.Update) {...})
          ...updateBlock,
        ],
        o.INFERRED_TYPE, null, this.templateName);
  }

  // LocalResolver
  getLocal(name: string): o.Expression|null { return this._bindingScope.get(name); }

  visitContent(ngContent: t.Content) {
    const slot = this.allocateDataSlot();
    const selectorIndex = ngContent.selectorIndex;
    const parameters: o.Expression[] = [o.literal(slot)];

    const attributeAsList: string[] = [];

    ngContent.attributes.forEach((attribute) => {
      const name = attribute.name;
      if (name !== 'select') {
        attributeAsList.push(name, attribute.value);
      }
    });

    if (attributeAsList.length > 0) {
      parameters.push(o.literal(selectorIndex), asLiteral(attributeAsList));
    } else if (selectorIndex !== 0) {
      parameters.push(o.literal(selectorIndex));
    }

    this.creationInstruction(ngContent.sourceSpan, R3.projection, parameters);
  }


  getNamespaceInstruction(namespaceKey: string|null) {
    switch (namespaceKey) {
      case 'math':
        return R3.namespaceMathML;
      case 'svg':
        return R3.namespaceSVG;
      default:
        return R3.namespaceHTML;
    }
  }

  addNamespaceInstruction(nsInstruction: o.ExternalReference, element: t.Element) {
    this._namespace = nsInstruction;
    this.creationInstruction(element.sourceSpan, nsInstruction);
  }

  visitElement(element: t.Element) {
    const elementIndex = this.allocateDataSlot();
    const wasInI18nSection = this._inI18nSection;

    const outputAttrs: {[name: string]: string} = {};
    const attrI18nMetas: {[name: string]: string} = {};
    let i18nMeta: string = '';

    const [namespaceKey, elementName] = splitNsName(element.name);
    const isNgContainer = checkIsNgContainer(element.name);

    // Elements inside i18n sections are replaced with placeholders
    // TODO(vicb): nested elements are a WIP in this phase
    if (this._inI18nSection) {
      const phName = element.name.toLowerCase();
      if (!this._phToNodeIdxes[this._i18nSectionIndex][phName]) {
        this._phToNodeIdxes[this._i18nSectionIndex][phName] = [];
      }
      this._phToNodeIdxes[this._i18nSectionIndex][phName].push(elementIndex);
    }

    let isNonBindableMode: boolean = false;

    // Handle i18n attributes
    for (const attr of element.attributes) {
      const name = attr.name;
      const value = attr.value;
      if (name === NON_BINDABLE_ATTR) {
        isNonBindableMode = true;
      } else if (name === I18N_ATTR) {
        if (this._inI18nSection) {
          throw new Error(
              `Could not mark an element as translatable inside of a translatable section`);
        }
        this._inI18nSection = true;
        this._i18nSectionIndex++;
        this._phToNodeIdxes[this._i18nSectionIndex] = {};
        i18nMeta = value;
      } else if (name.startsWith(I18N_ATTR_PREFIX)) {
        attrI18nMetas[name.slice(I18N_ATTR_PREFIX.length)] = value;
      } else {
        outputAttrs[name] = value;
      }
    }

    // Match directives on non i18n attributes
    this.matchDirectives(element.name, element);

    // Regular element or ng-container creation mode
    const parameters: o.Expression[] = [o.literal(elementIndex)];
    if (!isNgContainer) {
      parameters.push(o.literal(elementName));
    }

    // Add the attributes
    const attributes: o.Expression[] = [];
    const initialStyleDeclarations: o.Expression[] = [];
    const initialClassDeclarations: o.Expression[] = [];

    const styleInputs: t.BoundAttribute[] = [];
    const classInputs: t.BoundAttribute[] = [];
    const allOtherInputs: t.BoundAttribute[] = [];

    element.inputs.forEach((input: t.BoundAttribute) => {
      switch (input.type) {
        // [attr.style] or [attr.class] should not be treated as styling-based
        // bindings since they are intended to be written directly to the attr
        // and therefore will skip all style/class resolution that is present
        // with style="", [style]="" and [style.prop]="", class="",
        // [class.prop]="". [class]="" assignments
        case BindingType.Property:
          if (input.name == 'style') {
            // this should always go first in the compilation (for [style])
            styleInputs.splice(0, 0, input);
          } else if (isClassBinding(input)) {
            // this should always go first in the compilation (for [class])
            classInputs.splice(0, 0, input);
          } else {
            allOtherInputs.push(input);
          }
          break;
        case BindingType.Style:
          styleInputs.push(input);
          break;
        case BindingType.Class:
          classInputs.push(input);
          break;
        default:
          allOtherInputs.push(input);
          break;
      }
    });

    let currStyleIndex = 0;
    let currClassIndex = 0;
    let staticStylesMap: {[key: string]: any}|null = null;
    let staticClassesMap: {[key: string]: boolean}|null = null;
    const stylesIndexMap: {[key: string]: number} = {};
    const classesIndexMap: {[key: string]: number} = {};
    Object.getOwnPropertyNames(outputAttrs).forEach(name => {
      const value = outputAttrs[name];
      if (name == 'style') {
        staticStylesMap = parseStyle(value);
        Object.keys(staticStylesMap).forEach(prop => { stylesIndexMap[prop] = currStyleIndex++; });
      } else if (name == 'class') {
        staticClassesMap = {};
        value.split(/\s+/g).forEach(className => {
          classesIndexMap[className] = currClassIndex++;
          staticClassesMap ![className] = true;
        });
      } else {
        attributes.push(o.literal(name));
        if (attrI18nMetas.hasOwnProperty(name)) {
          const meta = parseI18nMeta(attrI18nMetas[name]);
          const variable = this.constantPool.getTranslation(value, meta, this.fileBasedI18nSuffix);
          attributes.push(variable);
        } else {
          attributes.push(o.literal(value));
        }
      }
    });

    let hasMapBasedStyling = false;
    for (let i = 0; i < styleInputs.length; i++) {
      const input = styleInputs[i];
      const isMapBasedStyleBinding = i === 0 && input.name === 'style';
      if (isMapBasedStyleBinding) {
        hasMapBasedStyling = true;
      } else if (!stylesIndexMap.hasOwnProperty(input.name)) {
        stylesIndexMap[input.name] = currStyleIndex++;
      }
    }

    for (let i = 0; i < classInputs.length; i++) {
      const input = classInputs[i];
      const isMapBasedClassBinding = i === 0 && isClassBinding(input);
      if (!isMapBasedClassBinding && !stylesIndexMap.hasOwnProperty(input.name)) {
        classesIndexMap[input.name] = currClassIndex++;
      }
    }

    // in the event that a [style] binding is used then sanitization will
    // always be imported because it is not possible to know ahead of time
    // whether style bindings will use or not use any sanitizable properties
    // that isStyleSanitizable() will detect
    let useDefaultStyleSanitizer = hasMapBasedStyling;

    // this will build the instructions so that they fall into the following syntax
    // => [prop1, prop2, prop3, 0, prop1, value1, prop2, value2]
    Object.keys(stylesIndexMap).forEach(prop => {
      useDefaultStyleSanitizer = useDefaultStyleSanitizer || isStyleSanitizable(prop);
      initialStyleDeclarations.push(o.literal(prop));
    });

    if (staticStylesMap) {
      initialStyleDeclarations.push(o.literal(core.InitialStylingFlags.VALUES_MODE));

      Object.keys(staticStylesMap).forEach(prop => {
        initialStyleDeclarations.push(o.literal(prop));
        const value = staticStylesMap ![prop];
        initialStyleDeclarations.push(o.literal(value));
      });
    }

    Object.keys(classesIndexMap).forEach(prop => {
      initialClassDeclarations.push(o.literal(prop));
    });

    if (staticClassesMap) {
      initialClassDeclarations.push(o.literal(core.InitialStylingFlags.VALUES_MODE));

      Object.keys(staticClassesMap).forEach(className => {
        initialClassDeclarations.push(o.literal(className));
        initialClassDeclarations.push(o.literal(true));
      });
    }

    const hasStylingInstructions = initialStyleDeclarations.length || styleInputs.length ||
        initialClassDeclarations.length || classInputs.length;

    // add attributes for directive matching purposes
    attributes.push(...this.prepareSyntheticAndSelectOnlyAttrs(allOtherInputs, element.outputs));
    parameters.push(this.toAttrsParam(attributes));

    // local refs (ex.: <div #foo #bar="baz">)
    parameters.push(this.prepareRefsParameter(element.references));

    const wasInNamespace = this._namespace;
    const currentNamespace = this.getNamespaceInstruction(namespaceKey);

    // If the namespace is changing now, include an instruction to change it
    // during element creation.
    if (currentNamespace !== wasInNamespace) {
      this.addNamespaceInstruction(currentNamespace, element);
    }

    const implicit = o.variable(CONTEXT_NAME);

    const createSelfClosingInstruction = !hasStylingInstructions && !isNgContainer &&
        element.children.length === 0 && element.outputs.length === 0;

    if (createSelfClosingInstruction) {
      this.creationInstruction(element.sourceSpan, R3.element, trimTrailingNulls(parameters));
    } else {
      this.creationInstruction(
          element.sourceSpan, isNgContainer ? R3.elementContainerStart : R3.elementStart,
          trimTrailingNulls(parameters));

      if (isNonBindableMode) {
        this.creationInstruction(element.sourceSpan, R3.disableBindings);
      }

      // initial styling for static style="..." attributes
      if (hasStylingInstructions) {
        const paramsList: (o.Expression)[] = [];

        if (initialClassDeclarations.length) {
          // the template compiler handles initial class styling (e.g. class="foo") values
          // in a special command called `elementClass` so that the initial class
          // can be processed during runtime. These initial class values are bound to
          // a constant because the inital class values do not change (since they're static).
          paramsList.push(
              this.constantPool.getConstLiteral(o.literalArr(initialClassDeclarations), true));
        } else if (initialStyleDeclarations.length || useDefaultStyleSanitizer) {
          // no point in having an extra `null` value unless there are follow-up params
          paramsList.push(o.NULL_EXPR);
        }

        if (initialStyleDeclarations.length) {
          // the template compiler handles initial style (e.g. style="foo") values
          // in a special command called `elementStyle` so that the initial styles
          // can be processed during runtime. These initial styles values are bound to
          // a constant because the inital style values do not change (since they're static).
          paramsList.push(
              this.constantPool.getConstLiteral(o.literalArr(initialStyleDeclarations), true));
        } else if (useDefaultStyleSanitizer) {
          // no point in having an extra `null` value unless there are follow-up params
          paramsList.push(o.NULL_EXPR);
        }

        if (useDefaultStyleSanitizer) {
          paramsList.push(o.importExpr(R3.defaultStyleSanitizer));
        }

        this.creationInstruction(null, R3.elementStyling, paramsList);
      }

      // Generate Listeners (outputs)
      element.outputs.forEach((outputAst: t.BoundEvent) => {
        this.creationInstruction(
            outputAst.sourceSpan, R3.listener,
            this.prepareListenerParameter(element.name, outputAst));
      });
    }

    if ((styleInputs.length || classInputs.length) && hasStylingInstructions) {
      const indexLiteral = o.literal(elementIndex);

      const firstStyle = styleInputs[0];
      const mapBasedStyleInput = firstStyle && firstStyle.name == 'style' ? firstStyle : null;

      const firstClass = classInputs[0];
      const mapBasedClassInput = firstClass && isClassBinding(firstClass) ? firstClass : null;

      const stylingInput = mapBasedStyleInput || mapBasedClassInput;
      if (stylingInput) {
        this.updateInstruction(stylingInput.sourceSpan, R3.elementStylingMap, () => {
          const params: o.Expression[] = [indexLiteral];

          if (mapBasedClassInput) {
            const mapBasedClassValue = mapBasedClassInput.value.visit(this._valueConverter);
            params.push(this.convertPropertyBinding(implicit, mapBasedClassValue, true));
          } else if (mapBasedStyleInput) {
            params.push(o.NULL_EXPR);
          }

          if (mapBasedStyleInput) {
            const mapBasedStyleValue = mapBasedStyleInput.value.visit(this._valueConverter);
            params.push(this.convertPropertyBinding(implicit, mapBasedStyleValue, true));
          }

          return params;
        });
      }

      let lastInputCommand: t.BoundAttribute|null = null;
      if (styleInputs.length) {
        let i = mapBasedStyleInput ? 1 : 0;
        for (i; i < styleInputs.length; i++) {
          const input = styleInputs[i];
          const params: any[] = [];
          const sanitizationRef = resolveSanitizationFn(input, input.securityContext);
          if (sanitizationRef) params.push(sanitizationRef);

          const key = input.name;
          const styleIndex: number = stylesIndexMap[key] !;
          const value = input.value.visit(this._valueConverter);
          this.updateInstruction(input.sourceSpan, R3.elementStyleProp, () => {
            return [
              indexLiteral, o.literal(styleIndex),
              this.convertPropertyBinding(implicit, value, true), ...params
            ];
          });
        }

        lastInputCommand = styleInputs[styleInputs.length - 1];
      }

      if (classInputs.length) {
        let i = mapBasedClassInput ? 1 : 0;
        for (i; i < classInputs.length; i++) {
          const input = classInputs[i];
          const params: any[] = [];
          const sanitizationRef = resolveSanitizationFn(input, input.securityContext);
          if (sanitizationRef) params.push(sanitizationRef);

          const key = input.name;
          const classIndex: number = classesIndexMap[key] !;
          const value = input.value.visit(this._valueConverter);
          this.updateInstruction(input.sourceSpan, R3.elementClassProp, () => {
            return [
              indexLiteral, o.literal(classIndex),
              this.convertPropertyBinding(implicit, value, true), ...params
            ];
          });
        }

        lastInputCommand = classInputs[classInputs.length - 1];
      }

      this.updateInstruction(lastInputCommand !.sourceSpan, R3.elementStylingApply, [indexLiteral]);
    }

    // Generate element input bindings
    allOtherInputs.forEach((input: t.BoundAttribute) => {
      const instruction = mapBindingToInstruction(input.type);
      if (input.type === BindingType.Animation) {
        const value = input.value.visit(this._valueConverter);
        // setAttribute without a value doesn't make any sense
        if (value.name || value.value) {
          const name = prepareSyntheticAttributeName(input.name);
          this.updateInstruction(input.sourceSpan, R3.elementAttribute, () => {
            return [
              o.literal(elementIndex), o.literal(name), this.convertPropertyBinding(implicit, value)
            ];
          });
        }
      } else if (instruction) {
        const params: any[] = [];
        const sanitizationRef = resolveSanitizationFn(input, input.securityContext);
        if (sanitizationRef) params.push(sanitizationRef);

        // TODO(chuckj): runtime: security context
        const value = input.value.visit(this._valueConverter);
        this.allocateBindingSlots(value);

        this.updateInstruction(input.sourceSpan, instruction, () => {
          return [
            o.literal(elementIndex), o.literal(input.name),
            this.convertPropertyBinding(implicit, value), ...params
          ];
        });
      } else {
        this._unsupported(`binding type ${input.type}`);
      }
    });

    // Traverse element child nodes
    if (this._inI18nSection && element.children.length == 1 &&
        element.children[0] instanceof t.Text) {
      const text = element.children[0] as t.Text;
      this.visitSingleI18nTextChild(text, i18nMeta);
    } else {
      t.visitAll(this, element.children);
    }

    if (!createSelfClosingInstruction) {
      // Finish element construction mode.
      if (isNonBindableMode) {
        this.creationInstruction(element.endSourceSpan || element.sourceSpan, R3.enableBindings);
      }
      this.creationInstruction(
          element.endSourceSpan || element.sourceSpan,
          isNgContainer ? R3.elementContainerEnd : R3.elementEnd);
    }

    // Restore the state before exiting this node
    this._inI18nSection = wasInI18nSection;
  }

  visitTemplate(template: t.Template) {
    const templateIndex = this.allocateDataSlot();

    let elName = '';
    if (template.children.length === 1 && template.children[0] instanceof t.Element) {
      // When the template as a single child, derive the context name from the tag
      elName = sanitizeIdentifier((template.children[0] as t.Element).name);
    }

    const contextName = elName ? `${this.contextName}_${elName}` : '';

    const templateName =
        contextName ? `${contextName}_Template_${templateIndex}` : `Template_${templateIndex}`;

    const parameters: o.Expression[] = [
      o.literal(templateIndex),
      o.variable(templateName),
      o.TYPED_NULL_EXPR,
    ];

    // find directives matching on a given <ng-template> node
    this.matchDirectives('ng-template', template);

    // prepare attributes parameter (including attributes used for directive matching)
    const attrsExprs: o.Expression[] = [];
    template.attributes.forEach(
        (a: t.TextAttribute) => { attrsExprs.push(asLiteral(a.name), asLiteral(a.value)); });
    attrsExprs.push(...this.prepareSyntheticAndSelectOnlyAttrs(template.inputs, template.outputs));
    parameters.push(this.toAttrsParam(attrsExprs));

    // local refs (ex.: <ng-template #foo>)
    if (template.references && template.references.length) {
      parameters.push(this.prepareRefsParameter(template.references));
      parameters.push(o.importExpr(R3.templateRefExtractor));
    }

    // handle property bindings e.g. p(1, 'forOf', ɵbind(ctx.items));
    const context = o.variable(CONTEXT_NAME);
    template.inputs.forEach(input => {
      const value = input.value.visit(this._valueConverter);
      this.allocateBindingSlots(value);
      this.updateInstruction(template.sourceSpan, R3.elementProperty, () => {
        return [
          o.literal(templateIndex), o.literal(input.name),
          this.convertPropertyBinding(context, value)
        ];
      });
    });

    // Create the template function
    const templateVisitor = new TemplateDefinitionBuilder(
        this.constantPool, this._bindingScope, this.level + 1, contextName, templateName, [],
        this.directiveMatcher, this.directives, this.pipeTypeByName, this.pipes, this._namespace,
        this.fileBasedI18nSuffix);

    // Nested templates must not be visited until after their parent templates have completed
    // processing, so they are queued here until after the initial pass. Otherwise, we wouldn't
    // be able to support bindings in nested templates to local refs that occur after the
    // template definition. e.g. <div *ngIf="showing"> {{ foo }} </div>  <div #foo></div>
    this._nestedTemplateFns.push(() => {
      const templateFunctionExpr =
          templateVisitor.buildTemplateFunction(template.children, template.variables);
      this.constantPool.statements.push(templateFunctionExpr.toDeclStmt(templateName, null));
    });

    // e.g. template(1, MyComp_Template_1)
    this.creationInstruction(template.sourceSpan, R3.templateCreate, () => {
      parameters.splice(
          2, 0, o.literal(templateVisitor.getConstCount()),
          o.literal(templateVisitor.getVarCount()));
      return trimTrailingNulls(parameters);
    });

    // Generate listeners for directive output
    template.outputs.forEach((outputAst: t.BoundEvent) => {
      this.creationInstruction(
          outputAst.sourceSpan, R3.listener,
          this.prepareListenerParameter('ng_template', outputAst));
    });
  }

  // These should be handled in the template or element directly.
  readonly visitReference = invalid;
  readonly visitVariable = invalid;
  readonly visitTextAttribute = invalid;
  readonly visitBoundAttribute = invalid;
  readonly visitBoundEvent = invalid;

  visitBoundText(text: t.BoundText) {
    const nodeIndex = this.allocateDataSlot();

    this.creationInstruction(text.sourceSpan, R3.text, [o.literal(nodeIndex)]);

    const value = text.value.visit(this._valueConverter);
    this.allocateBindingSlots(value);
    this.updateInstruction(
        text.sourceSpan, R3.textBinding,
        () => [o.literal(nodeIndex), this.convertPropertyBinding(o.variable(CONTEXT_NAME), value)]);
  }

  visitText(text: t.Text) {
    this.creationInstruction(
        text.sourceSpan, R3.text, [o.literal(this.allocateDataSlot()), o.literal(text.value)]);
  }

  // When the content of the element is a single text node the translation can be inlined:
  //
  // `<p i18n="desc|mean">some content</p>`
  // compiles to
  // ```
  // /**
  // * @desc desc
  // * @meaning mean
  // */
  // const MSG_XYZ = goog.getMsg('some content');
  // i0.ɵtext(1, MSG_XYZ);
  // ```
  visitSingleI18nTextChild(text: t.Text, i18nMeta: string) {
    const meta = parseI18nMeta(i18nMeta);
    const variable = this.constantPool.getTranslation(text.value, meta, this.fileBasedI18nSuffix);
    this.creationInstruction(
        text.sourceSpan, R3.text, [o.literal(this.allocateDataSlot()), variable]);
  }

  private allocateDataSlot() { return this._dataIndex++; }

  getConstCount() { return this._dataIndex; }

  getVarCount() { return this._pureFunctionSlots; }

  private bindingContext() { return `${this._bindingContext++}`; }

  // Bindings must only be resolved after all local refs have been visited, so all
  // instructions are queued in callbacks that execute once the initial pass has completed.
  // Otherwise, we wouldn't be able to support local refs that are defined after their
  // bindings. e.g. {{ foo }} <div #foo></div>
  private instructionFn(
      fns: (() => o.Statement)[], span: ParseSourceSpan|null, reference: o.ExternalReference,
      paramsOrFn: o.Expression[]|(() => o.Expression[])): void {
    fns.push(() => {
      const params = Array.isArray(paramsOrFn) ? paramsOrFn : paramsOrFn();
      return instruction(span, reference, params).toStmt();
    });
  }

  private creationInstruction(
      span: ParseSourceSpan|null, reference: o.ExternalReference,
      paramsOrFn?: o.Expression[]|(() => o.Expression[])) {
    this.instructionFn(this._creationCodeFns, span, reference, paramsOrFn || []);
  }

  private updateInstruction(
      span: ParseSourceSpan|null, reference: o.ExternalReference,
      paramsOrFn?: o.Expression[]|(() => o.Expression[])) {
    this.instructionFn(this._updateCodeFns, span, reference, paramsOrFn || []);
  }

  private allocatePureFunctionSlots(numSlots: number): number {
    const originalSlots = this._pureFunctionSlots;
    this._pureFunctionSlots += numSlots;
    return originalSlots;
  }

  private allocateBindingSlots(value: AST) {
    this._bindingSlots += value instanceof Interpolation ? value.expressions.length : 1;
  }

  private convertPropertyBinding(implicit: o.Expression, value: AST, skipBindFn?: boolean):
      o.Expression {
    const interpolationFn =
        value instanceof Interpolation ? interpolate : () => error('Unexpected interpolation');

    const convertedPropertyBinding = convertPropertyBinding(
        this, implicit, value, this.bindingContext(), BindingForm.TrySimple, interpolationFn);
    this._tempVariables.push(...convertedPropertyBinding.stmts);

    const valExpr = convertedPropertyBinding.currValExpr;
    return value instanceof Interpolation || skipBindFn ? valExpr :
                                                          o.importExpr(R3.bind).callFn([valExpr]);
  }

  private matchDirectives(tagName: string, elOrTpl: t.Element|t.Template) {
    if (this.directiveMatcher) {
      const selector = createCssSelector(tagName, this.getAttrsForDirectiveMatching(elOrTpl));
      this.directiveMatcher.match(
          selector, (cssSelector, staticType) => { this.directives.add(staticType); });
    }
  }

  private getAttrsForDirectiveMatching(elOrTpl: t.Element|t.Template): {[name: string]: string} {
    const attributesMap: {[name: string]: string} = {};

    elOrTpl.attributes.forEach(a => {
      if (!isI18NAttribute(a.name)) {
        attributesMap[a.name] = a.value;
      }
    });
    elOrTpl.inputs.forEach(i => { attributesMap[i.name] = ''; });
    elOrTpl.outputs.forEach(o => { attributesMap[o.name] = ''; });

    return attributesMap;
  }

  private prepareSyntheticAndSelectOnlyAttrs(inputs: t.BoundAttribute[], outputs: t.BoundEvent[]):
      o.Expression[] {
    const attrExprs: o.Expression[] = [];
    const nonSyntheticInputs: t.BoundAttribute[] = [];

    if (inputs.length) {
      const EMPTY_STRING_EXPR = asLiteral('');
      inputs.forEach(input => {
        if (input.type === BindingType.Animation) {
          // @attributes are for Renderer2 animation @triggers, but this feature
          // may be supported differently in future versions of angular. However,
          // @triggers should always just be treated as regular attributes (it's up
          // to the renderer to detect and use them in a special way).
          attrExprs.push(asLiteral(prepareSyntheticAttributeName(input.name)), EMPTY_STRING_EXPR);
        } else {
          nonSyntheticInputs.push(input);
        }
      });
    }

    if (nonSyntheticInputs.length || outputs.length) {
      attrExprs.push(o.literal(core.AttributeMarker.SelectOnly));
      nonSyntheticInputs.forEach((i: t.BoundAttribute) => attrExprs.push(asLiteral(i.name)));
      outputs.forEach((o: t.BoundEvent) => attrExprs.push(asLiteral(o.name)));
    }

    return attrExprs;
  }

  private toAttrsParam(attrsExprs: o.Expression[]): o.Expression {
    return attrsExprs.length > 0 ?
        this.constantPool.getConstLiteral(o.literalArr(attrsExprs), true) :
        o.TYPED_NULL_EXPR;
  }

  private prepareRefsParameter(references: t.Reference[]): o.Expression {
    if (!references || references.length === 0) {
      return o.TYPED_NULL_EXPR;
    }

    const refsParam = flatten(references.map(reference => {
      const slot = this.allocateDataSlot();
      // Generate the update temporary.
      const variableName = this._bindingScope.freshReferenceName();
      const retrievalLevel = this.level;
      const lhs = o.variable(variableName);
      this._bindingScope.set(
          retrievalLevel, reference.name, lhs, DeclarationPriority.DEFAULT,
          (scope: BindingScope, relativeLevel: number) => {
            // e.g. x(2);
            const nextContextStmt =
                relativeLevel > 0 ? [generateNextContextExpr(relativeLevel).toStmt()] : [];

            // e.g. const $foo$ = r(1);
            const refExpr = lhs.set(o.importExpr(R3.reference).callFn([o.literal(slot)]));
            return nextContextStmt.concat(refExpr.toConstDecl());
          });
      return [reference.name, reference.value];
    }));

    return this.constantPool.getConstLiteral(asLiteral(refsParam), true);
  }

  private prepareListenerParameter(tagName: string, outputAst: t.BoundEvent): () => o.Expression[] {
    const evName = sanitizeIdentifier(outputAst.name);
    const functionName = `${this.templateName}_${tagName}_${evName}_listener`;

    return () => {

      const listenerScope = this._bindingScope.nestedScope(this._bindingScope.bindingLevel);

      const bindingExpr = convertActionBinding(
          listenerScope, o.variable(CONTEXT_NAME), outputAst.handler, 'b',
          () => error('Unexpected interpolation'));

      const statements = [
        ...listenerScope.restoreViewStatement(), ...listenerScope.variableDeclarations(),
        ...bindingExpr.render3Stmts
      ];

      const handler = o.fn(
          [new o.FnParam('$event', o.DYNAMIC_TYPE)], statements, o.INFERRED_TYPE, null,
          functionName);

      return [o.literal(outputAst.name), handler];
    };
  }
}

export class ValueConverter extends AstMemoryEfficientTransformer {
  private _pipeBindExprs: FunctionCall[] = [];

  constructor(
      private constantPool: ConstantPool, private allocateSlot: () => number,
      private allocatePureFunctionSlots: (numSlots: number) => number,
      private definePipe:
          (name: string, localName: string, slot: number, value: o.Expression) => void) {
    super();
  }

  // AstMemoryEfficientTransformer
  visitPipe(pipe: BindingPipe, context: any): AST {
    // Allocate a slot to create the pipe
    const slot = this.allocateSlot();
    const slotPseudoLocal = `PIPE:${slot}`;
    // Allocate one slot for the result plus one slot per pipe argument
    const pureFunctionSlot = this.allocatePureFunctionSlots(2 + pipe.args.length);
    const target = new PropertyRead(pipe.span, new ImplicitReceiver(pipe.span), slotPseudoLocal);
    const {identifier, isVarLength} = pipeBindingCallInfo(pipe.args);
    this.definePipe(pipe.name, slotPseudoLocal, slot, o.importExpr(identifier));
    const args: AST[] = [pipe.exp, ...pipe.args];
    const convertedArgs: AST[] =
        isVarLength ? this.visitAll([new LiteralArray(pipe.span, args)]) : this.visitAll(args);

    const pipeBindExpr = new FunctionCall(pipe.span, target, [
      new LiteralPrimitive(pipe.span, slot),
      new LiteralPrimitive(pipe.span, pureFunctionSlot),
      ...convertedArgs,
    ]);
    this._pipeBindExprs.push(pipeBindExpr);
    return pipeBindExpr;
  }

  updatePipeSlotOffsets(bindingSlots: number) {
    this._pipeBindExprs.forEach((pipe: FunctionCall) => {
      // update the slot offset arg (index 1) to account for binding slots
      const slotOffset = pipe.args[1] as LiteralPrimitive;
      (slotOffset.value as number) += bindingSlots;
    });
  }

  visitLiteralArray(array: LiteralArray, context: any): AST {
    return new BuiltinFunctionCall(array.span, this.visitAll(array.expressions), values => {
      // If the literal has calculated (non-literal) elements transform it into
      // calls to literal factories that compose the literal and will cache intermediate
      // values. Otherwise, just return an literal array that contains the values.
      const literal = o.literalArr(values);
      return values.every(a => a.isConstant()) ?
          this.constantPool.getConstLiteral(literal, true) :
          getLiteralFactory(this.constantPool, literal, this.allocatePureFunctionSlots);
    });
  }

  visitLiteralMap(map: LiteralMap, context: any): AST {
    return new BuiltinFunctionCall(map.span, this.visitAll(map.values), values => {
      // If the literal has calculated (non-literal) elements  transform it into
      // calls to literal factories that compose the literal and will cache intermediate
      // values. Otherwise, just return an literal array that contains the values.
      const literal = o.literalMap(values.map(
          (value, index) => ({key: map.keys[index].key, value, quoted: map.keys[index].quoted})));
      return values.every(a => a.isConstant()) ?
          this.constantPool.getConstLiteral(literal, true) :
          getLiteralFactory(this.constantPool, literal, this.allocatePureFunctionSlots);
    });
  }
}

// Pipes always have at least one parameter, the value they operate on
const pipeBindingIdentifiers = [R3.pipeBind1, R3.pipeBind2, R3.pipeBind3, R3.pipeBind4];

function pipeBindingCallInfo(args: o.Expression[]) {
  const identifier = pipeBindingIdentifiers[args.length];
  return {
    identifier: identifier || R3.pipeBindV,
    isVarLength: !identifier,
  };
}

const pureFunctionIdentifiers = [
  R3.pureFunction0, R3.pureFunction1, R3.pureFunction2, R3.pureFunction3, R3.pureFunction4,
  R3.pureFunction5, R3.pureFunction6, R3.pureFunction7, R3.pureFunction8
];

function pureFunctionCallInfo(args: o.Expression[]) {
  const identifier = pureFunctionIdentifiers[args.length];
  return {
    identifier: identifier || R3.pureFunctionV,
    isVarLength: !identifier,
  };
}

function instruction(
    span: ParseSourceSpan | null, reference: o.ExternalReference,
    params: o.Expression[]): o.Expression {
  return o.importExpr(reference, null, span).callFn(params, span);
}

// e.g. x(2);
function generateNextContextExpr(relativeLevelDiff: number): o.Expression {
  return o.importExpr(R3.nextContext)
      .callFn(relativeLevelDiff > 1 ? [o.literal(relativeLevelDiff)] : []);
}

function getLiteralFactory(
    constantPool: ConstantPool, literal: o.LiteralArrayExpr | o.LiteralMapExpr,
    allocateSlots: (numSlots: number) => number): o.Expression {
  const {literalFactory, literalFactoryArguments} = constantPool.getLiteralFactory(literal);
  // Allocate 1 slot for the result plus 1 per argument
  const startSlot = allocateSlots(1 + literalFactoryArguments.length);
  literalFactoryArguments.length > 0 || error(`Expected arguments to a literal factory function`);
  const {identifier, isVarLength} = pureFunctionCallInfo(literalFactoryArguments);

  // Literal factories are pure functions that only need to be re-invoked when the parameters
  // change.
  const args = [
    o.literal(startSlot),
    literalFactory,
  ];

  if (isVarLength) {
    args.push(o.literalArr(literalFactoryArguments));
  } else {
    args.push(...literalFactoryArguments);
  }

  return o.importExpr(identifier).callFn(args);
}

/**
 * Function which is executed whenever a variable is referenced for the first time in a given
 * scope.
 *
 * It is expected that the function creates the `const localName = expression`; statement.
 */
export type DeclareLocalVarCallback = (scope: BindingScope, relativeLevel: number) => o.Statement[];

/** The prefix used to get a shared context in BindingScope's map. */
const SHARED_CONTEXT_KEY = '$$shared_ctx$$';

/**
 * This is used when one refers to variable such as: 'let abc = x(2).$implicit`.
 * - key to the map is the string literal `"abc"`.
 * - value `retrievalLevel` is the level from which this value can be retrieved, which is 2 levels
 * up in example.
 * - value `lhs` is the left hand side which is an AST representing `abc`.
 * - value `declareLocalCallback` is a callback that is invoked when declaring the local.
 * - value `declare` is true if this value needs to be declared.
 * - value `priority` dictates the sorting priority of this var declaration compared
 * to other var declarations on the same retrieval level. For example, if there is a
 * context variable and a local ref accessing the same parent view, the context var
 * declaration should always come before the local ref declaration.
 */
type BindingData = {
  retrievalLevel: number; lhs: o.ReadVarExpr; declareLocalCallback?: DeclareLocalVarCallback;
  declare: boolean;
  priority: number;
};

/**
 * The sorting priority of a local variable declaration. Higher numbers
 * mean the declaration will appear first in the generated code.
 */
const enum DeclarationPriority { DEFAULT = 0, CONTEXT = 1, SHARED_CONTEXT = 2 }

export class BindingScope implements LocalResolver {
  /** Keeps a map from local variables to their BindingData. */
  private map = new Map<string, BindingData>();
  private referenceNameIndex = 0;
  private restoreViewVariable: o.ReadVarExpr|null = null;
  private static _ROOT_SCOPE: BindingScope;

  static get ROOT_SCOPE(): BindingScope {
    if (!BindingScope._ROOT_SCOPE) {
      BindingScope._ROOT_SCOPE = new BindingScope().set(0, '$event', o.variable('$event'));
    }
    return BindingScope._ROOT_SCOPE;
  }

  private constructor(public bindingLevel: number = 0, private parent: BindingScope|null = null) {}

  get(name: string): o.Expression|null {
    let current: BindingScope|null = this;
    while (current) {
      let value = current.map.get(name);
      if (value != null) {
        if (current !== this) {
          // make a local copy and reset the `declare` state
          value = {
            retrievalLevel: value.retrievalLevel,
            lhs: value.lhs,
            declareLocalCallback: value.declareLocalCallback,
            declare: false,
            priority: value.priority
          };

          // Cache the value locally.
          this.map.set(name, value);
          // Possibly generate a shared context var
          this.maybeGenerateSharedContextVar(value);
          this.maybeRestoreView(value.retrievalLevel);
        }

        if (value.declareLocalCallback && !value.declare) {
          value.declare = true;
        }
        return value.lhs;
      }
      current = current.parent;
    }

    // If we get to this point, we are looking for a property on the top level component
    // - If level === 0, we are on the top and don't need to re-declare `ctx`.
    // - If level > 0, we are in an embedded view. We need to retrieve the name of the
    // local var we used to store the component context, e.g. const $comp$ = x();
    return this.bindingLevel === 0 ? null : this.getComponentProperty(name);
  }

  /**
   * Create a local variable for later reference.
   *
   * @param retrievalLevel The level from which this value can be retrieved
   * @param name Name of the variable.
   * @param lhs AST representing the left hand side of the `let lhs = rhs;`.
   * @param priority The sorting priority of this var
   * @param declareLocalCallback The callback to invoke when declaring this local var
   */
  set(retrievalLevel: number, name: string, lhs: o.ReadVarExpr,
      priority: number = DeclarationPriority.DEFAULT,
      declareLocalCallback?: DeclareLocalVarCallback): BindingScope {
    !this.map.has(name) ||
        error(`The name ${name} is already defined in scope to be ${this.map.get(name)}`);
    this.map.set(name, {
      retrievalLevel: retrievalLevel,
      lhs: lhs,
      declare: false,
      declareLocalCallback: declareLocalCallback,
      priority: priority
    });
    return this;
  }

  getLocal(name: string): (o.Expression|null) { return this.get(name); }

  nestedScope(level: number): BindingScope {
    const newScope = new BindingScope(level, this);
    if (level > 0) newScope.generateSharedContextVar(0);
    return newScope;
  }

  getSharedContextName(retrievalLevel: number): o.ReadVarExpr|null {
    const sharedCtxObj = this.map.get(SHARED_CONTEXT_KEY + retrievalLevel);
    return sharedCtxObj && sharedCtxObj.declare ? sharedCtxObj.lhs : null;
  }

  maybeGenerateSharedContextVar(value: BindingData) {
    if (value.priority === DeclarationPriority.CONTEXT) {
      const sharedCtxObj = this.map.get(SHARED_CONTEXT_KEY + value.retrievalLevel);
      if (sharedCtxObj) {
        sharedCtxObj.declare = true;
      } else {
        this.generateSharedContextVar(value.retrievalLevel);
      }
    }
  }

  generateSharedContextVar(retrievalLevel: number) {
    const lhs = o.variable(CONTEXT_NAME + this.freshReferenceName());
    this.map.set(SHARED_CONTEXT_KEY + retrievalLevel, {
      retrievalLevel: retrievalLevel,
      lhs: lhs,
      declareLocalCallback: (scope: BindingScope, relativeLevel: number) => {
        // const ctx_r0 = x(2);
        return [lhs.set(generateNextContextExpr(relativeLevel)).toConstDecl()];
      },
      declare: false,
      priority: DeclarationPriority.SHARED_CONTEXT
    });
  }

  getComponentProperty(name: string): o.Expression {
    const componentValue = this.map.get(SHARED_CONTEXT_KEY + 0) !;
    componentValue.declare = true;
    this.maybeRestoreView(0);
    return componentValue.lhs.prop(name);
  }

  maybeRestoreView(retrievalLevel: number) {
    if (this.isListenerScope() && retrievalLevel < this.bindingLevel) {
      if (!this.parent !.restoreViewVariable) {
        // parent saves variable to generate a shared `const $s$ = gV();` instruction
        this.parent !.restoreViewVariable = o.variable(this.parent !.freshReferenceName());
      }
      this.restoreViewVariable = this.parent !.restoreViewVariable;
    }
  }

  restoreViewStatement(): o.Statement[] {
    // rV($state$);
    return this.restoreViewVariable ?
        [instruction(null, R3.restoreView, [this.restoreViewVariable]).toStmt()] :
        [];
  }

  viewSnapshotStatements(): o.Statement[] {
    // const $state$ = gV();
    const getCurrentViewInstruction = instruction(null, R3.getCurrentView, []);
    return this.restoreViewVariable ?
        [this.restoreViewVariable.set(getCurrentViewInstruction).toConstDecl()] :
        [];
  }

  isListenerScope() { return this.parent && this.parent.bindingLevel === this.bindingLevel; }

  variableDeclarations(): o.Statement[] {
    let currentContextLevel = 0;
    return Array.from(this.map.values())
        .filter(value => value.declare)
        .sort((a, b) => b.retrievalLevel - a.retrievalLevel || b.priority - a.priority)
        .reduce((stmts: o.Statement[], value: BindingData) => {
          const levelDiff = this.bindingLevel - value.retrievalLevel;
          const currStmts = value.declareLocalCallback !(this, levelDiff - currentContextLevel);
          currentContextLevel = levelDiff;
          return stmts.concat(currStmts);
        }, []) as o.Statement[];
  }


  freshReferenceName(): string {
    let current: BindingScope = this;
    // Find the top scope as it maintains the global reference count
    while (current.parent) current = current.parent;
    const ref = `${REFERENCE_PREFIX}${current.referenceNameIndex++}`;
    return ref;
  }
}

/**
 * Creates a `CssSelector` given a tag name and a map of attributes
 */
function createCssSelector(tag: string, attributes: {[name: string]: string}): CssSelector {
  const cssSelector = new CssSelector();

  cssSelector.setElement(tag);

  Object.getOwnPropertyNames(attributes).forEach((name) => {
    const value = attributes[name];

    cssSelector.addAttribute(name, value);
    if (name.toLowerCase() === 'class') {
      const classes = value.trim().split(/\s+/g);
      classes.forEach(className => cssSelector.addClassName(className));
    }
  });

  return cssSelector;
}

// Parse i18n metas like:
// - "@@id",
// - "description[@@id]",
// - "meaning|description[@@id]"
function parseI18nMeta(i18n?: string): {description?: string, id?: string, meaning?: string} {
  let meaning: string|undefined;
  let description: string|undefined;
  let id: string|undefined;

  if (i18n) {
    // TODO(vicb): figure out how to force a message ID with closure ?
    const idIndex = i18n.indexOf(ID_SEPARATOR);

    const descIndex = i18n.indexOf(MEANING_SEPARATOR);
    let meaningAndDesc: string;
    [meaningAndDesc, id] =
        (idIndex > -1) ? [i18n.slice(0, idIndex), i18n.slice(idIndex + 2)] : [i18n, ''];
    [meaning, description] = (descIndex > -1) ?
        [meaningAndDesc.slice(0, descIndex), meaningAndDesc.slice(descIndex + 1)] :
        ['', meaningAndDesc];
  }

  return {description, id, meaning};
}

function interpolate(args: o.Expression[]): o.Expression {
  args = args.slice(1);  // Ignore the length prefix added for render2
  switch (args.length) {
    case 3:
      return o.importExpr(R3.interpolation1).callFn(args);
    case 5:
      return o.importExpr(R3.interpolation2).callFn(args);
    case 7:
      return o.importExpr(R3.interpolation3).callFn(args);
    case 9:
      return o.importExpr(R3.interpolation4).callFn(args);
    case 11:
      return o.importExpr(R3.interpolation5).callFn(args);
    case 13:
      return o.importExpr(R3.interpolation6).callFn(args);
    case 15:
      return o.importExpr(R3.interpolation7).callFn(args);
    case 17:
      return o.importExpr(R3.interpolation8).callFn(args);
  }
  (args.length >= 19 && args.length % 2 == 1) ||
      error(`Invalid interpolation argument length ${args.length}`);
  return o.importExpr(R3.interpolationV).callFn([o.literalArr(args)]);
}

/**
 * Parse a template into render3 `Node`s and additional metadata, with no other dependencies.
 *
 * @param template text of the template to parse
 * @param templateUrl URL to use for source mapping of the parsed template
 */
export function parseTemplate(
    template: string, templateUrl: string, options: {preserveWhitespaces?: boolean} = {},
    relativeContextFilePath: string): {
  errors?: ParseError[],
  nodes: t.Node[],
  hasNgContent: boolean,
  ngContentSelectors: string[],
  relativeContextFilePath: string
} {
  const bindingParser = makeBindingParser();
  const htmlParser = new HtmlParser();
  const parseResult = htmlParser.parse(template, templateUrl);

  if (parseResult.errors && parseResult.errors.length > 0) {
    return {
      errors: parseResult.errors,
      nodes: [],
      hasNgContent: false,
      ngContentSelectors: [], relativeContextFilePath
    };
  }

  let rootNodes: html.Node[] = parseResult.rootNodes;
  if (!options.preserveWhitespaces) {
    rootNodes = html.visitAll(new WhitespaceVisitor(), rootNodes);
  }

  const {nodes, hasNgContent, ngContentSelectors, errors} =
      htmlAstToRender3Ast(rootNodes, bindingParser);
  if (errors && errors.length > 0) {
    return {
      errors,
      nodes: [],
      hasNgContent: false,
      ngContentSelectors: [], relativeContextFilePath
    };
  }

  return {nodes, hasNgContent, ngContentSelectors, relativeContextFilePath};
}

/**
 * Construct a `BindingParser` with a default configuration.
 */
export function makeBindingParser(): BindingParser {
  return new BindingParser(
      new Parser(new Lexer()), DEFAULT_INTERPOLATION_CONFIG, new DomElementSchemaRegistry(), null,
      []);
}

function isClassBinding(input: t.BoundAttribute): boolean {
  return input.name == 'className' || input.name == 'class';
}

function resolveSanitizationFn(input: t.BoundAttribute, context: core.SecurityContext) {
  switch (context) {
    case core.SecurityContext.HTML:
      return o.importExpr(R3.sanitizeHtml);
    case core.SecurityContext.SCRIPT:
      return o.importExpr(R3.sanitizeScript);
    case core.SecurityContext.STYLE:
      // the compiler does not fill in an instruction for [style.prop?] binding
      // values because the style algorithm knows internally what props are subject
      // to sanitization (only [attr.style] values are explicitly sanitized)
      return input.type === BindingType.Attribute ? o.importExpr(R3.sanitizeStyle) : null;
    case core.SecurityContext.URL:
      return o.importExpr(R3.sanitizeUrl);
    case core.SecurityContext.RESOURCE_URL:
      return o.importExpr(R3.sanitizeResourceUrl);
    default:
      return null;
  }
}

function isStyleSanitizable(prop: string): boolean {
  switch (prop) {
    case 'background-image':
    case 'background':
    case 'border-image':
    case 'filter':
    case 'list-style':
    case 'list-style-image':
      return true;
  }
  return false;
}

function prepareSyntheticAttributeName(name: string) {
  return '@' + name;
}
