# Neat MD Sample

A tour of everything Neat MD renders. Click into any element to see its Markdown; move away and it renders again.

[toc]

## Text

**Bold**, *italic*, ***bold italic***, ~~strikethrough~~, `inline code`, a [link](https://github.com), an autolink <https://example.com>, and a footnote[^note].

Line one ends with two spaces
so this is a hard line break.

> Blockquotes can hold **formatting**, `code` and
> several lines.
>
> > And they can be nested.

---

## Lists

- A short item
- A long item whose text keeps going well past the right edge of the editor, so you can see that wrapped lines line up with the text after the bullet instead of falling back under it.
  - Nested items get their own bullet and indent, and wrapped lines in a nested item also align with that item's text rather than with its parent.
    - Third level, with a long enough sentence to wrap onto a second line in a normal window width.
- Back to the first level

1. First step
2. Second step with a long explanation that wraps onto the next line, which should start right under the word "Second" and not under the number.
   1. Sub-step one
   2. Sub-step two
10. Double-digit numbers keep the text aligned too
11. Eleven

- [x] Write the spec
- [x] Build the editor, including a long task description that wraps so the checkbox stays in its own column
- [ ] Publish
  - [ ] Nested task

## Tables

Simple, with alignment:

| Left | Center | Right |
| :--- | :----: | ----: |
| a    |   b    |     1 |
| c    |   d    |    22 |

Wide table that scrolls sideways; columns keep their natural width:

| ID   | Name                      | Region        |     Status     | Owner         | Created    | Updated    | Tags         | Priority | Notes                                      |
| ---- | ------------------------- | ------------- | :------------: | ------------- | ---------- | ---------- | ------------ | -------: | ------------------------------------------ |
| 1001 | Login page redesign       | North America |     ✅ Done     | Alice Johnson | 2026-01-04 | 2026-02-11 | `ui`, `auth` |        1 | Shipped behind a feature flag first        |
| 1002 | **Payment retries**       | Europe        | 🚧 In progress | Bob Smith     | 2026-01-15 | 2026-03-02 | `billing`    |        2 | Needs [design review](https://example.com) |
| 1003 | 搜索结果排序优化          | 亚太地区      |   ⏳ Waiting    | 王小明        | 2026-02-01 | 2026-03-20 | `search`     |        3 | 中文内容和英文 mixed content               |
| 1004 | Escaped \| pipe in a cell | Global        |   ❌ Blocked    | Carol         | 2026-02-10 | 2026-02-10 | `infra`      |        5 | Formula $O(n \log n)$ inside a cell        |

Cells with long text wrap at a comfortable width:

| Term | Definition |
| --- | --- |
| Idempotent | An operation that produces the same result no matter how many times it is applied, which makes retries safe after timeouts or network failures. |
| Eventual consistency | Replicas may briefly disagree after a write, but converge to the same value once updates stop arriving. |

## Code

```ts
interface User {
  id: number;
  name: string;
}

export async function load(id: number): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

    def norm(self) -> float:
        return (self.x ** 2 + self.y ** 2) ** 0.5
```

```bash
npm install && npm run build
```

## Math

Inline: $E = mc^2$, $\alpha + \beta = \gamma$, and $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$. Prices like $5 and $10 stay text.

Gaussian integral:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

A system of equations:

$$
\begin{cases}
2x + 3y - z = 1 \\
x - y + 2z = -2 \\
3x + y + z = 4
\end{cases}
$$

Aligned derivation:

$$
\begin{aligned}
(a + b)^2 &= (a + b)(a + b) \\
          &= a^2 + ab + ba + b^2 \\
          &= a^2 + 2ab + b^2
\end{aligned}
$$

Matrix and determinant:

$$
A = \begin{pmatrix} a_{11} & a_{12} & a_{13} \\ a_{21} & a_{22} & a_{23} \\ a_{31} & a_{32} & a_{33} \end{pmatrix},
\qquad
\det(A) = \sum_{\sigma \in S_3} \operatorname{sgn}(\sigma) \prod_{i=1}^{3} a_{i,\sigma(i)}
$$

Maxwell's equations:

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} &
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} &
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$

## Diagrams

### Flowchart with labeled edges and subgraphs

```mermaid
flowchart TD
    Start([Request received]) --> Auth{Signed in?}
    Auth -->|No| Login[Show login page]
    Login --> Auth
    Auth -->|Yes| Cache{In cache?}
    Cache -->|Hit| Respond[Return cached page]
    Cache -->|Miss| Build

    subgraph Build [Render pipeline]
        direction LR
        Fetch[Fetch data] --> Template[Apply template] --> Minify[Minify HTML]
    end

    Build --> Store[(Write cache)]
    Store --> Respond
    Respond --> Done([Response sent])
```

### Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant App
    participant API
    participant DB as Database
    User->>App: Click "Save"
    App->>API: PUT /documents/42
    activate API
    API->>DB: UPDATE documents (in a transaction)
    alt version matches
        DB-->>API: 1 row updated
        API-->>App: 200 OK
    else conflict
        DB-->>API: 0 rows updated
        API-->>App: 409 Conflict
        App->>User: Show merge dialog
    end
    deactivate API
    Note over App,API: Retries use exponential backoff
```

### Class diagram

```mermaid
classDiagram
    class Shape {
        <<abstract>>
        +String name
        +area() double
        +perimeter() double
    }
    class Circle {
        +double radius
        +area() double
    }
    class Rectangle {
        +double width
        +double height
        +area() double
    }
    class Canvas {
        -List~Shape~ shapes
        +add(Shape s)
        +render()
    }
    Shape <|-- Circle
    Shape <|-- Rectangle
    Canvas "1" o-- "*" Shape : contains
```

### State diagram

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Review : submit
    Review --> Draft : request changes
    Review --> Approved : approve
    Approved --> Published : publish
    Published --> Archived : archive
    Archived --> [*]
    state Review {
        [*] --> Waiting
        Waiting --> Reviewing : reviewer assigned
        Reviewing --> [*]
    }
```

### Entity relationship diagram

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "ordered in"
    CUSTOMER {
        int id PK
        string name
        string email
    }
    ORDER {
        int id PK
        int customer_id FK
        date created
    }
    LINE_ITEM {
        int order_id FK
        int product_id FK
        int quantity
    }
    PRODUCT {
        int id PK
        string title
        decimal price
    }
```

### Gantt chart

```mermaid
gantt
    title Release plan
    dateFormat YYYY-MM-DD
    section Design
        Research          :done,    des1, 2026-01-05, 7d
        Wireframes        :done,    des2, after des1, 5d
    section Build
        Editor core       :active,  dev1, 2026-01-19, 14d
        Tables and paste  :         dev2, after dev1, 10d
    section Release
        Beta              :milestone, m1, after dev2, 0d
        Marketplace       :         rel1, after m1, 3d
```

### Pie chart

```mermaid
pie showData
    title Time spent this week
    "Coding" : 42
    "Reviews" : 18
    "Meetings" : 12
    "Docs" : 8
```

### User journey

```mermaid
journey
    title Writing a blog post
    section Draft
      Outline ideas: 4: Writer
      Write first draft: 3: Writer
    section Polish
      Add diagrams: 5: Writer
      Review: 3: Writer, Editor
    section Publish
      Post online: 5: Writer
```

### Git graph

```mermaid
gitGraph
    commit id: "init"
    branch feature
    checkout feature
    commit id: "add tables"
    commit id: "add paste"
    checkout main
    commit id: "fix typo"
    merge feature
    commit id: "release"
```

### Mind map

```mermaid
mindmap
  root((Neat MD))
    Editing
      Live mode
      Source mode
      Split views
    Content
      Tables
      Math
      Diagrams
    Files
      Paste images
      Save to assets
```

### Timeline

```mermaid
timeline
    title Markdown history
    2004 : Markdown created by John Gruber
    2014 : CommonMark specification
    2017 : GitHub Flavored Markdown spec
    2026 : Neat MD
```

### Quadrant chart

```mermaid
quadrantChart
    title Feature priorities
    x-axis Low effort --> High effort
    y-axis Low impact --> High impact
    quadrant-1 Plan carefully
    quadrant-2 Do first
    quadrant-3 Maybe later
    quadrant-4 Avoid
    Live tables: [0.7, 0.9]
    Paste as Markdown: [0.3, 0.8]
    Custom themes: [0.6, 0.3]
    Keyboard help: [0.2, 0.4]
```

## Containers

:::note
A note with **formatting** and a list:

- one
- two
:::

:::tip Pro tip
Containers can have their own title.
:::

:::warning
Mind the gap.
:::

:::danger
Do not run this in production.
:::

## Images

![Placeholder](https://via.placeholder.com/320x120.png?text=Neat+MD)

Paste or drop an image here: it is saved to the `assets` folder next to this file.

[^note]: Footnotes collect at the end of the document.
