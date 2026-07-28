import 'reflect-metadata';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DECORATORS } from '@nestjs/swagger';
import { AppModule } from '../../app.module';

type ClassRef = { prototype: object; name: string };

function isClassRef(value: unknown): value is ClassRef {
  return typeof value === 'function';
}

// Walks the same @Module({ imports, controllers }) graph Nest itself uses
// to register routes, so newly added modules/controllers are picked up
// automatically — nothing to remember to add to a list by hand.
function collectControllers(
  moduleClass: unknown,
  seen = new Set<unknown>(),
): ClassRef[] {
  if (!isClassRef(moduleClass) || seen.has(moduleClass)) {
    return [];
  }
  seen.add(moduleClass);

  const controllers =
    (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) as
      | unknown[]
      | undefined) ?? [];
  const imports =
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) as
      | unknown[]
      | undefined) ?? [];

  // DynamicModule results (TypeOrmModule.forFeature(), JwtModule.registerAsync(),
  // etc.) aren't classes and carry no controllers of interest here — skipped
  // by isClassRef inside the recursive call itself.
  const nested = imports.flatMap((imp) => collectControllers(imp, seen));

  return [...controllers.filter(isClassRef), ...nested];
}

describe('OpenAPI documentation completeness', () => {
  const controllers = collectControllers(AppModule);

  // Guards the check itself — if the module-graph walk above ever breaks
  // (e.g. a Nest version renames its metadata keys), every route check
  // below would silently no-op instead of failing.
  it('discovers at least one controller via the module graph', () => {
    expect(controllers.length).toBeGreaterThan(0);
  });

  for (const controller of controllers) {
    const controllerExcluded = Reflect.getMetadata(
      DECORATORS.API_EXCLUDE_CONTROLLER,
      controller,
    ) as boolean | undefined;
    if (controllerExcluded) {
      continue;
    }

    const prototype = controller.prototype as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor',
    );

    for (const methodName of methodNames) {
      const handler = prototype[methodName] as object;
      const isRouteHandler = Reflect.hasMetadata(PATH_METADATA, handler);
      if (!isRouteHandler) {
        continue;
      }

      // Escape hatch for endpoints that shouldn't appear in the reference
      // at all — provider webhooks are the expected case: mark them with
      // @ApiExcludeEndpoint() (or @ApiExcludeController() on the whole
      // controller) rather than adding a name/path allowlist here.
      const endpointExcluded = Reflect.getMetadata(
        DECORATORS.API_EXCLUDE_ENDPOINT,
        handler,
      ) as boolean | undefined;
      if (endpointExcluded) {
        continue;
      }

      it(`${controller.name}.${methodName} has an @ApiOperation summary`, () => {
        const operation = Reflect.getMetadata(
          DECORATORS.API_OPERATION,
          handler,
        ) as { summary?: string } | undefined;
        expect(operation?.summary).toBeTruthy();
      });
    }
  }
});
