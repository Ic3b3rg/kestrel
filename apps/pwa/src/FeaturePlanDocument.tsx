import { useId } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { DEFAULT_FACTORY_LIMITS, type FeaturePlanDocument } from "@kestrel/contracts";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { Textarea } from "./components/ui/textarea.js";

type WorkItem = FeaturePlanDocument["workItems"][number];
type Verification = WorkItem["verification"][number];

const emptyVerification = (): Verification => ({
  program: "",
  args: [],
  cwd: ".",
  timeoutSeconds: 300,
});
const emptyItem = (key: string, requirementKeys: string[]): WorkItem => ({
  key,
  title: "",
  description: "",
  requirementKeys,
  importedIssueId: null,
  acceptance: [""],
  dependsOn: [],
  verification: [emptyVerification()],
});
export function emptyFeaturePlan(): FeaturePlanDocument {
  return {
    objective: "",
    scope: { includes: [""], excludes: [] },
    acceptance: [{ key: "R1", outcome: "" }],
    workItems: [emptyItem("W1", ["R1"])],
    limits: { ...DEFAULT_FACTORY_LIMITS },
  };
}

function nextKey(prefix: string, keys: string[]): string {
  let index = 1;
  while (keys.includes(`${prefix}${String(index)}`)) index += 1;
  return `${prefix}${String(index)}`;
}

function TextList({
  label,
  values,
  onChange,
  max = 20,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  max?: number;
}) {
  const id = useId();
  return (
    <fieldset className="plan-text-list">
      <legend>{label}</legend>
      {values.map((value, index) => (
        <div className="plan-list-row" key={index}>
          <Label className="sr-only" htmlFor={`${id}-${String(index)}`}>
            {label} {index + 1}
          </Label>
          <Textarea
            id={`${id}-${String(index)}`}
            value={value}
            rows={2}
            maxLength={2000}
            onChange={(event) =>
              onChange(
                values.map((current, position) =>
                  position === index ? event.target.value : current,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${label.toLowerCase()} ${String(index + 1)}`}
            onClick={() => onChange(values.filter((_, position) => position !== index))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={values.length >= max}
        onClick={() => onChange([...values, ""])}
      >
        <Plus aria-hidden="true" />
        Add {label.toLowerCase()}
      </Button>
    </fieldset>
  );
}

function KeyChoices({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: string; title: string }[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const known = new Set(options.map(({ key }) => key));
  const choices = [
    ...options,
    ...value
      .filter((key) => !known.has(key))
      .map((key) => ({ key, title: "Update this reference" })),
  ];
  return (
    <fieldset className="plan-key-choices">
      <legend>{label}</legend>
      {choices.length === 0 ? (
        <p>No earlier Work Items.</p>
      ) : (
        choices.map(({ key, title }, index) => (
          <label key={`${key}-${String(index)}`}>
            <input
              type="checkbox"
              checked={value.includes(key)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, key]
                    : value.filter((current) => current !== key),
                )
              }
            />
            <span>
              <strong>{key || "Unnamed"}</strong> {title}
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}

function VerificationFields({
  value,
  onChange,
  index,
}: {
  value: Verification;
  onChange: (value: Verification) => void;
  index: number;
}) {
  const id = useId();
  return (
    <div className="plan-verification-fields">
      <div>
        <Label htmlFor={`${id}-program`}>Program {index + 1}</Label>
        <Input
          id={`${id}-program`}
          maxLength={128}
          value={value.program}
          placeholder="For example, npm"
          onChange={(event) => onChange({ ...value, program: event.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${id}-cwd`}>Project directory {index + 1}</Label>
        <Input
          id={`${id}-cwd`}
          maxLength={256}
          value={value.cwd}
          onChange={(event) => onChange({ ...value, cwd: event.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${id}-args`}>Arguments {index + 1}, one per line</Label>
        <Textarea
          id={`${id}-args`}
          rows={3}
          value={value.args.join("\n")}
          onChange={(event) =>
            onChange({
              ...value,
              args: event.target.value === "" ? [] : event.target.value.split(/\r?\n/u),
            })
          }
        />
      </div>
      <div>
        <Label htmlFor={`${id}-timeout`}>Verification timeout {index + 1} (seconds)</Label>
        <Input
          id={`${id}-timeout`}
          type="number"
          min={1}
          max={7200}
          value={value.timeoutSeconds || ""}
          onChange={(event) => onChange({ ...value, timeoutSeconds: Number(event.target.value) })}
        />
      </div>
    </div>
  );
}

export function FeaturePlanEditor({
  plan,
  onChange,
  disabled,
}: {
  plan: FeaturePlanDocument;
  onChange: (plan: FeaturePlanDocument) => void;
  disabled: boolean;
}) {
  const updateItem = (index: number, item: WorkItem) =>
    onChange({
      ...plan,
      workItems: plan.workItems.map((current, position) => (position === index ? item : current)),
    });
  const moveItem = (index: number, direction: -1 | 1) => {
    const items = [...plan.workItems];
    const item = items.splice(index, 1)[0];
    if (item === undefined) return;
    items.splice(index + direction, 0, item);
    onChange({ ...plan, workItems: items });
  };
  return (
    <fieldset disabled={disabled} className="feature-plan-editor">
      <legend className="sr-only">Edit feature plan</legend>
      <div>
        <Label htmlFor="plan-objective">Objective</Label>
        <Textarea
          id="plan-objective"
          rows={3}
          maxLength={4000}
          value={plan.objective}
          onChange={(event) => onChange({ ...plan, objective: event.target.value })}
        />
      </div>
      <div className="plan-scope-grid">
        <TextList
          label="Included scope"
          values={plan.scope.includes}
          onChange={(includes) => onChange({ ...plan, scope: { ...plan.scope, includes } })}
        />
        <TextList
          label="Excluded scope"
          values={plan.scope.excludes}
          onChange={(excludes) => onChange({ ...plan, scope: { ...plan.scope, excludes } })}
        />
      </div>
      <section className="plan-editor-section" aria-labelledby="plan-requirements-title">
        <h3 id="plan-requirements-title">Acceptance outcomes</h3>
        <p>Each outcome has a stable key that links it to its Work Items.</p>
        {plan.acceptance.map((requirement, index) => (
          <div className="plan-requirement-editor" key={index}>
            <div>
              <Label htmlFor={`requirement-key-${String(index)}`}>
                Requirement key {index + 1}
              </Label>
              <Input
                id={`requirement-key-${String(index)}`}
                maxLength={48}
                value={requirement.key}
                onChange={(event) =>
                  onChange({
                    ...plan,
                    acceptance: plan.acceptance.map((current, position) =>
                      position === index ? { ...current, key: event.target.value } : current,
                    ),
                  })
                }
              />
            </div>
            <div>
              <Label htmlFor={`requirement-outcome-${String(index)}`}>Outcome {index + 1}</Label>
              <Textarea
                id={`requirement-outcome-${String(index)}`}
                maxLength={2000}
                rows={2}
                value={requirement.outcome}
                onChange={(event) =>
                  onChange({
                    ...plan,
                    acceptance: plan.acceptance.map((current, position) =>
                      position === index ? { ...current, outcome: event.target.value } : current,
                    ),
                  })
                }
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove requirement ${String(index + 1)}`}
              onClick={() =>
                onChange({
                  ...plan,
                  acceptance: plan.acceptance.filter((_, position) => position !== index),
                })
              }
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={plan.acceptance.length >= 40}
          onClick={() =>
            onChange({
              ...plan,
              acceptance: [
                ...plan.acceptance,
                {
                  key: nextKey(
                    "R",
                    plan.acceptance.map(({ key }) => key),
                  ),
                  outcome: "",
                },
              ],
            })
          }
        >
          <Plus aria-hidden="true" />
          Add outcome
        </Button>
      </section>
      <section className="plan-editor-section" aria-labelledby="plan-work-items-title">
        <h3 id="plan-work-items-title">Ordered Work Items</h3>
        <p>
          Dependencies must appear earlier in this order. Each item declares its acceptance and
          verification.
        </p>
        {plan.workItems.map((item, index) => (
          <section
            className="plan-item-editor"
            key={index}
            aria-label={`Work Item ${String(index + 1)}`}
          >
            <header>
              <h4>Work Item {index + 1}</h4>
              <div className="plan-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={index === 0}
                  aria-label={`Move Work Item ${String(index + 1)} up`}
                  onClick={() => moveItem(index, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={index === plan.workItems.length - 1}
                  aria-label={`Move Work Item ${String(index + 1)} down`}
                  onClick={() => moveItem(index, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove Work Item ${String(index + 1)}`}
                  onClick={() =>
                    onChange({
                      ...plan,
                      workItems: plan.workItems.filter((_, position) => position !== index),
                    })
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            </header>
            <div className="plan-scope-grid">
              <div>
                <Label htmlFor={`work-key-${String(index)}`}>Work Item key {index + 1}</Label>
                <Input
                  id={`work-key-${String(index)}`}
                  maxLength={48}
                  value={item.key}
                  onChange={(event) => updateItem(index, { ...item, key: event.target.value })}
                />
              </div>
              <div>
                <Label htmlFor={`work-title-${String(index)}`}>Work Item title {index + 1}</Label>
                <Input
                  id={`work-title-${String(index)}`}
                  maxLength={160}
                  value={item.title}
                  onChange={(event) => updateItem(index, { ...item, title: event.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor={`work-description-${String(index)}`}>Description {index + 1}</Label>
              <Textarea
                id={`work-description-${String(index)}`}
                maxLength={8000}
                rows={3}
                value={item.description}
                onChange={(event) =>
                  updateItem(index, { ...item, description: event.target.value })
                }
              />
            </div>
            <KeyChoices
              label="Requirements"
              options={plan.acceptance.map(({ key, outcome }) => ({ key, title: outcome }))}
              value={item.requirementKeys}
              onChange={(requirementKeys) => updateItem(index, { ...item, requirementKeys })}
            />
            <KeyChoices
              label="Depends on"
              options={plan.workItems.slice(0, index).map(({ key, title }) => ({ key, title }))}
              value={item.dependsOn}
              onChange={(dependsOn) => updateItem(index, { ...item, dependsOn })}
            />
            <TextList
              label={`Work Item ${String(index + 1)} acceptance`}
              values={item.acceptance}
              onChange={(acceptance) => updateItem(index, { ...item, acceptance })}
            />
            <fieldset className="plan-verifications">
              <legend>Verification commands</legend>
              <p>
                Each command runs a program directly in a relative Project directory. Put each
                argument on its own line.
              </p>
              {item.verification.map((command, commandIndex) => (
                <div className="plan-verification-editor" key={commandIndex}>
                  <VerificationFields
                    index={commandIndex}
                    value={command}
                    onChange={(value) =>
                      updateItem(index, {
                        ...item,
                        verification: item.verification.map((current, position) =>
                          position === commandIndex ? value : current,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      updateItem(index, {
                        ...item,
                        verification: item.verification.filter(
                          (_, position) => position !== commandIndex,
                        ),
                      })
                    }
                  >
                    Remove command {commandIndex + 1}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={item.verification.length >= 12}
                onClick={() =>
                  updateItem(index, {
                    ...item,
                    verification: [...item.verification, emptyVerification()],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Add verification command
              </Button>
            </fieldset>
          </section>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={plan.workItems.length >= 40}
          onClick={() =>
            onChange({
              ...plan,
              workItems: [
                ...plan.workItems,
                emptyItem(
                  nextKey(
                    "W",
                    plan.workItems.map(({ key }) => key),
                  ),
                  [],
                ),
              ],
            })
          }
        >
          <Plus aria-hidden="true" />
          Add Work Item
        </Button>
      </section>
      <section className="plan-editor-section" aria-labelledby="plan-limits-title">
        <h3 id="plan-limits-title">Execution limits</h3>
        <div className="plan-scope-grid">
          <div>
            <Label htmlFor="plan-concurrent-projects">Concurrent Projects</Label>
            <NativeSelect
              id="plan-concurrent-projects"
              value={plan.limits.maxConcurrentProjects}
              onChange={(event) =>
                onChange({
                  ...plan,
                  limits: { ...plan.limits, maxConcurrentProjects: Number(event.target.value) },
                })
              }
            >
              <option value={1}>1 Project</option>
              <option value={2}>2 Projects</option>
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="plan-attempt-limit">Attempt limit (minutes)</Label>
            <Input
              id="plan-attempt-limit"
              type="number"
              min={1}
              max={120}
              step="any"
              value={plan.limits.attemptTimeoutSeconds / 60 || ""}
              onChange={(event) =>
                onChange({
                  ...plan,
                  limits: {
                    ...plan.limits,
                    attemptTimeoutSeconds: Math.round(Number(event.target.value) * 60),
                  },
                })
              }
            />
          </div>
        </div>
        <p>One active feature per Project. These limits are frozen with the approved version.</p>
      </section>
    </fieldset>
  );
}

export function VerificationSummary({ commands }: { commands: Verification[] }) {
  return (
    <ul className="plan-verification-summary">
      {commands.map((command, index) => (
        <li key={index}>
          <code>
            {[
              command.program,
              ...command.args.map((argument) =>
                /\s/u.test(argument) || argument === "" ? JSON.stringify(argument) : argument,
              ),
            ].join(" ")}
          </code>
          <span>
            Directory: <code>{command.cwd}</code> · Timeout: {command.timeoutSeconds} seconds
          </span>
        </li>
      ))}
    </ul>
  );
}

export function FeaturePlanDocumentView({ plan }: { plan: FeaturePlanDocument }) {
  return (
    <div className="feature-plan-document">
      <section>
        <h3>Objective</h3>
        <p className="planning-message-content">{plan.objective}</p>
      </section>
      <div className="plan-scope-grid">
        <section>
          <h3>Included scope</h3>
          <ul>
            {plan.scope.includes.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Excluded scope</h3>
          {plan.scope.excludes.length === 0 ? (
            <p>No exclusions declared.</p>
          ) : (
            <ul>
              {plan.scope.excludes.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section>
        <h3>Acceptance outcomes</h3>
        <dl className="plan-outcomes">
          {plan.acceptance.map(({ key, outcome }) => (
            <div key={key} id={`requirement-${key}`}>
              <dt>{key}</dt>
              <dd>{outcome}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h3>Ordered Work Items</h3>
        <ol className="plan-work-items">
          {plan.workItems.map((item, index) => (
            <li key={item.key}>
              <h4>
                {index + 1}. {item.title} <span className="plan-key">{item.key}</span>
              </h4>
              <p className="planning-message-content">{item.description}</p>
              <p>
                Requirements:{" "}
                {item.requirementKeys.map((key, position) => (
                  <span key={key}>
                    {position === 0 ? "" : ", "}
                    <a href={`#requirement-${key}`}>{key}</a>
                  </span>
                ))}
              </p>
              <p>
                Depends on:{" "}
                {item.dependsOn.length === 0 ? "No dependencies" : item.dependsOn.join(", ")}
              </p>
              <h5>Acceptance</h5>
              <ul>
                {item.acceptance.map((value, position) => (
                  <li key={position}>{value}</li>
                ))}
              </ul>
              <h5>Verification</h5>
              <VerificationSummary commands={item.verification} />
            </li>
          ))}
        </ol>
      </section>
      <section className="plan-frozen-limits">
        <h3>Execution limits</h3>
        <p>
          {plan.limits.maxConcurrentProjects} concurrent Projects · 1 active feature per Project ·{" "}
          {plan.limits.attemptTimeoutSeconds / 60} minutes per attempt
        </p>
      </section>
    </div>
  );
}
