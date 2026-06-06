# Pi Workbench

Pi Workbench is a local personal workspace for using Pi across focused work and creative writing while keeping conversations, saved outputs, and long-form writing memory organised.

## Language

**Project**:
A user-named local container that gathers work on the same undertaking.
_Avoid_: unnamed project, workspace, folder, archive item

**Work**:
A creative-writing undertaking represented by a **Project** when the user is writing fiction, prose, essays, or scripts.
_Avoid_: treating Work as a separate top-level entity from Project

**Artifact**:
A durable output saved by Pi for a **Project**, such as Markdown, Fountain, or CSV.
_Avoid_: file, notebook content, preview

**Notebook**:
The preview surface where an **Artifact** is rendered for reading.
_Avoid_: artifact, file

**Story Bible**:
Structured continuity notes for a creative **Work**, separate from finished **Artifacts**.
_Avoid_: memory, brain, artifact

## Relationships

- A **Project** may represent a **Work** when used for creative writing.
- A **Work** is not independent from a **Project** in Pi Workbench.
- A **Project** can contain many **Artifacts**.
- A **Notebook** renders one **Artifact** at a time.
- A creative **Work** can have one **Story Bible**.
- A **Story Bible** contains continuity notes, not finished **Artifacts**.

## Example dialogue

> **Dev:** "If the user opens the phone view and sends a prompt, should we create an unnamed project?"
> **Domain expert:** "No. The user must choose or create a **Project** first; a **Work** is just a creative-writing **Project**."
>
> **Dev:** "When Pi saves a Markdown draft, is that the notebook?"
> **Domain expert:** "No. The saved draft is an **Artifact**; the **Notebook** is where the user previews it."
>
> **Dev:** "Should character notes appear in the same list as finished chapters?"
> **Domain expert:** "No. Character notes belong in the **Story Bible**; finished chapters are **Artifacts**."

## Flagged ambiguities

- "project" and "work" were used interchangeably. Resolved: **Project** is the top-level container; **Work** is a creative-writing use of a **Project**.
- "artifact", "file", and "notebook content" were used interchangeably. Resolved: an **Artifact** is the saved output; the **Notebook** is the preview surface.
- "memory", "brain", and "bible" were used interchangeably. Resolved: **Story Bible** is the canonical term; memory is only informal UI shorthand.
