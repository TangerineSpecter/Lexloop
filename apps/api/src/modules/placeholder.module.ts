import { Controller, Get, Module } from '@nestjs/common';

export function createPlaceholderModule(path: string, label: string) {
  @Controller(path)
  class PlaceholderController { @Get() status() { return { module: label, status: 'planned' }; } }
  @Module({ controllers: [PlaceholderController] })
  class PlaceholderModule {}
  return PlaceholderModule;
}
