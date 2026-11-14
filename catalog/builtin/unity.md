---
kind: rule
title: Unity 규칙
title_en: Unity rules
summary: Unity C# 스크립트를 프레임마다 가볍고 안전하게 써요
summary_en: Unity C# scripts that stay cheap per frame and safe
detail: Assets 아래 C# 스크립트를 다룰 때만 적용돼요. 컴포넌트 참조 캐싱, Update에서 할당·검색 피하기, 물리는 FixedUpdate, 직렬화 필드, 이벤트 해제, .meta 파일 다루기 같은 Unity 특유의 규칙을 따르게 해요.
detail_en: Applies only to C# scripts under Assets: cached component references, no allocation or lookup in Update, physics in FixedUpdate, serialized fields, unsubscribing from events, and how to treat .meta files.
category: C#
category_en: C#
paths:
  - "Assets/**/*.cs"
tokens: 0
performance: 1
quality: 1
---
# Unity

- Get component references once (`Awake` or `Start`, or a serialized field) and keep them; never call `GetComponent`, `Find`, `FindObjectOfType` or `Camera.main` every frame.
- Expose inspector values with `[SerializeField] private`, not public fields. Mark values that must not change at run time `readonly` or `const`.
- Keep `Update` free of allocations: no LINQ, no string building, no `new` collections per frame. Reuse lists and pool objects that spawn often instead of `Instantiate` and `Destroy`.
- Move with physics in `FixedUpdate` (through the `Rigidbody`); read input and move transforms in `Update` scaled by `Time.deltaTime`.
- A destroyed `UnityEngine.Object` compares equal to null only through Unity's own `==`. Check it with `if (thing)` or `== null`; don't use `?.` or `??` on Unity objects.
- Subscribe to events in `OnEnable` and unsubscribe in `OnDisable`; stop coroutines you started when the object is disabled.
- Put shared, read-only data in `ScriptableObject` assets rather than in singletons or static fields.
- Never create, edit or delete `.meta` files by hand, and move or rename assets inside the editor (or with their `.meta` file) so references survive.
- Editor-only code goes in an `Editor` folder or behind `#if UNITY_EDITOR`; it must not end up in a build.
- One `MonoBehaviour` per file, the file named after the class.
