import Resolver from '@forge/resolver';

const resolver = new Resolver();

resolver.define('main', (req) => {
  console.log(req);

  return {
    content: 'Hello World!',
  };
});

export const handler = resolver.getDefinitions();
