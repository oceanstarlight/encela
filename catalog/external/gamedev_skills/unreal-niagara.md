---
kind: skill
title: 언리얼 나이아가 VFX
title_en: Unreal Niagara VFX
summary: 게임플레이가 조작하고 정리할 수 있는 나이아가 이펙트를 만들고 스폰하게 해요
summary_en: Makes Claude build and spawn Niagara effects that gameplay can drive, clean up and keep visible.
detail: UE5 파티클 이펙트를 만들거나 이펙트가 안 보이고, 화면 가장자리에서 사라지고, 멈추지 않을 때 써요. User 파라미터, 모듈 순서, CPU/GPU 시뮬, C++·블루프린트 스폰, 풀링, 바운드를 다뤄요.
detail_en: Applies to any Unreal Engine 5 particle effect, effects that do not show, vanish at the screen edge or never stop. Covers User parameters, module order, CPU vs GPU sim, C++ and Blueprint spawning, pooling and bounds.
category: 게임 개발
category_en: Game development
name: unreal-niagara
description: "Unreal Engine 5 (UE 5.8) Niagara VFX: systems, emitters, User parameters, spawning from C++ or Blueprints, bounds and GPU vs CPU sim. Use for any Unreal particle effect, NS_ assets, muzzle flashes or impacts, or effects that do not show, vanish at the screen edge or never stop. Not for Unity VFX Graph, shader authoring (`shader-programming`) or hit-stop (`game-feel`)."
license: Apache-2.0
copyright: "Copyright 2026 Abhishek Barali and the awesome-gamedev-agent-skills contributors"
source_repo: gamedev-skills/awesome-gamedev-agent-skills
source_commit: c6ca6c41c839b68319ffc08430b99ab768debc32
source_path: skills/unreal/unreal-niagara/SKILL.md
license_path: LICENSE
---
# Unreal Niagara VFX

Build UE5 effects that gameplay can spawn, drive and clean up, and that keep rendering where
the camera actually looks. Targets **UE 5.8**. Niagara replaced Cascade, which is deprecated.

## When to use

- Creating or editing Niagara Systems (`NS_`) and Emitters (`NE_`), module order, User
  parameters, renderers, bounds and scalability.
- Spawning, attaching, parameterizing, pooling or stopping effects from C++ or Blueprints.
- Debugging effects that don't appear, cull wrongly, leak or cost too much.

**When *not* to use:** Unity VFX Graph or particles in other engines are not covered here.
Material and shader logic → `shader-programming`. Juice such as screen shake and hit-stop →
`game-feel`. Audio for the effect → `audio-design`.

## Workflow

1. **Read the project.** Check `EngineAssociation`, list existing `NS_*`/`NE_*` assets and
   emitter templates, and grep `Source` for `UNiagaraComponent` to find the spawn path already
   in use. C++ access needs `"Niagara"` in the module's `*.Build.cs`; without it the includes
   compile and the link fails.
2. **Expose what gameplay changes as User parameters.** Only the `User` namespace can be set
   from Blueprint or C++; `System`, `Emitter` and `Particle` values are internal to the sim.
3. **Order modules deliberately.** Modules run top to bottom in each stage, so a force placed
   before the module that initializes velocity acts on zero.
4. **Pick the sim target.** Default to CPU for small counts and anything gameplay reacts to
   (events, collision callbacks); use GPU for large counts of purely visual particles, and give
   GPU emitters fixed bounds.
5. **Spawn from gameplay, never from the Construction Script.**
   `UNiagaraFunctionLibrary::SpawnSystemAtLocation` for world-space one-shots,
   `SpawnSystemAttached` for effects that follow a component or socket. For frequent one-shots
   (impacts, footsteps) pass a pooling method instead of creating a component each time.
6. **Own the lifetime.** One-shots use a non-looping system with auto-destroy or auto-release;
   looping effects keep the returned component and call `Deactivate()` when done.
7. **Check it (see Verify).**

## Patterns

### One-shot impact (pooled) and a driven looping effect

```cpp
#include "NiagaraFunctionLibrary.h"
#include "NiagaraComponent.h"

void AProjectile::SpawnImpact(const FVector& Location, const FRotator& Rotation)
{
    // ImpactSystem: UPROPERTY(EditAnywhere) TObjectPtr<UNiagaraSystem>, non-looping.
    UNiagaraFunctionLibrary::SpawnSystemAtLocation(
        GetWorld(), ImpactSystem, Location, Rotation, FVector(1.f),
        /*bAutoDestroy*/ true, /*bAutoActivate*/ true, ENCPoolMethod::AutoRelease);
    // With AutoRelease the component goes back to the pool when it finishes:
    // don't keep the returned pointer.
}

void ATorch::BeginPlay()
{
    Super::BeginPlay();
    Fire = UNiagaraFunctionLibrary::SpawnSystemAttached(   // Fire: UPROPERTY TObjectPtr<UNiagaraComponent>
        FireSystem, RootComponent, NAME_None, FVector::ZeroVector, FRotator::ZeroRotator,
        EAttachLocation::KeepRelativeOffset, /*bAutoDestroy*/ false);
    if (Fire)                                              // null on servers or when pre-culled
    {
        Fire->SetVariableFloat(TEXT("SpawnRate"), 250.f);  // the User.SpawnRate parameter
        Fire->SetVariableLinearColor(TEXT("FireColor"), FLinearColor::Red);
    }
}
```

Blueprint uses the same nodes: Spawn System at Location or Spawn System Attached, then Set
Niagara Variable (Float, LinearColor and so on) on the returned component.

## Verify

Say which of these you ran.

1. **Compile** the module (`Build.bat`/`Build.sh`).
2. **Validate assets:** `UnrealEditor-Cmd <Project>.uproject -run=DataValidation -unattended`
   and fix errors in the systems you touched.
3. **Functional test for gameplay-spawned effects:** spawn the system in a test map, assert the
   returned component is valid and active, then (for a one-shot) that it has finished after its
   lifetime. Niagara needs a renderer, so run it with `-RenderOffscreen` rather than `-nullrhi`:
   `UnrealEditor-Cmd <Project>.uproject -ExecCmds="Automation RunTest Project.Functional Tests;Quit" -unattended -RenderOffscreen -ReportExportPath="<dir>"`.
4. **Ask the user** to run PIE and use the Niagara Debugger (Tools > Debug > Niagara Debugger)
   or the console: `fx.Niagara.Debug.Hud Enabled=1` for the debug HUD, `fx.Niagara.DumpComponents`
   to list live components in the log, `stat Niagara` for cost. Ask them to report whether the
   effect appears, whether it disappears when its origin leaves the screen (bounds), and the
   active component count after a minute of play (leaks).

## Gotchas

- **Setting a parameter does nothing:** it isn't in the `User` namespace, or the name passed to
  `SetVariable*` doesn't match it exactly.
- **Crash on the returned component:** spawn functions return `nullptr` when there is no system
  asset, on a dedicated server, or when scalability pre-culls the effect. Null-check before use.
- **Effect vanishes when its origin leaves the screen:** bounds are too small or dynamic bounds
  were never computed. GPU emitters need fixed bounds set on the emitter or system.
- **Looping effect never stops or components pile up:** spawned with auto-destroy off and never
  deactivated, or the system loops when it should be one-shot.
- **Pooled component changes under you:** with `AutoRelease` the pool reuses it after it
  finishes. Use `ManualRelease` (and release it yourself) if you must keep driving it.
- **Gameplay can't read the particles:** GPU sim data isn't read back to the CPU. Use a CPU
  emitter for anything gameplay reacts to.
- **Following a Cascade tutorial:** different system. Port old assets with the Cascade To
  Niagara Converter plugin as a starting point.
- **Spawning from the Construction Script:** the spawn functions are marked unsafe during actor
  construction. Spawn from BeginPlay or later.
- **Wrong argument lands in the wrong slot:** `SpawnSystemAttached` takes `PoolingMethod`
  before `bAutoActivate`, unlike `SpawnSystemAtLocation`. Check the order in
  `NiagaraFunctionLibrary.h` before passing optional arguments.

## References

- Epic docs: [Overview of Niagara Effects](https://dev.epicgames.com/documentation/unreal-engine/overview-of-niagara-effects-for-unreal-engine),
  [Niagara Debugger](https://dev.epicgames.com/documentation/unreal-engine/niagara-debugger-for-unreal-engine),
  [Console commands reference](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-console-commands-reference).

## Version notes

Last verified: 2026-11-11.

- Current release: UE 5.8 (5.8.4 hotfix, October 2026); UE 5.9 is in Preview.
- 5.8: new Spawn By Trigger module, Random Jitter and Ramp In/Out dynamic inputs, GPU bitonic
  sort for small particle counts, and a `FiltersEnabled=` option for the debug HUD command.
- 5.9 Preview: the Unreal Animation Framework gains a Play Niagara Effect notify handler, and
  AVBOIT order-independent transparency changes how overlapping translucent particles blend.
- Sources: [UE 5.8 release notes](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes),
  [UE 5.9 Preview release notes](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-9-release-notes),
  [Niagara Debugger](https://dev.epicgames.com/documentation/unreal-engine/niagara-debugger-for-unreal-engine).
