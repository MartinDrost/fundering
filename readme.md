<p align='center'>
    A pragmatic service framework for structured and reactive data handling using <a href='https://github.com/Automattic/mongoose' target='_blank'>Mongoose</a>.
</p>

<p align='center'><i>Fun · deer · ing - The Dutch word for foundation</i></p>

<p align='center'>
    <a href='https://www.npmjs.com/~fundering' target='_blank'><img src='https://img.shields.io/npm/v/fundering.svg' alt='NPM Version' /></a>
    <a href='https://www.npmjs.com/~fundering' target='_blank'><img src='https://img.shields.io/npm/dt/fundering.svg' alt='NPM Downloads' /></a>
    <a href='https://bundlephobia.com/result?p=fundering' target='_blank'><img src='https://badgen.net/bundlephobia/min/fundering' alt='Minified bundle size' /></a>
    <a href='https://bundlephobia.com/result?p=fundering' target='_blank'><img src='https://badgen.net/bundlephobia/minzip/fundering' alt='Minified + GZipped bundle size' /></a>
</p>

## Description

Fundering acts as a ground layer of your service architecture and helps you keep your application structured by offering helper methods and reactive hooks. Rather than reinventing the wheel, the framework uses [Mongoose](https://github.com/Automattic/mongoose) ORM for communication with MongoDB and extends upon the functionality that is already there. A few examples of these functionalities are; dynamic population, recursive authorization, query type casting and support for dependency injection in document middleware.

## Installation

```bash
$ npm install fundering mongoose
```

## Getting started

Initializing a service is as easy as extending the abstract `CrudService` class and passing your schema model in the constructor. This class registers your service with fundering for cross-service authorization and casting, and offers a set of methods which help you with basic CRUD actions.

```Typescript
import { CrudService } from 'fundering';
import { IUser } from './user.interface';
import { model } from 'mongoose';
import { userSchema } from './user.schema';

export class UsersService extends CrudService<IUser> {
  constructor() {
    super(model('User', userSchema));
  }
}
```

## Examples

### Querying

MongoDB aggregations are great, powerful and fast, but they can also be complex, hard to maintain and (really) slow. The find methods in the `CrudService` help you keep the positive set of adjectives by utilizing common aggregations for you. The features vary from adding referenced documents to your conditions to randomly sorting the collection before selecting results. The `IQueryOptions` object also allows you to extend existing methods with extra query conditions for a more dynamic codebase.

```Typescript
class UsersService extends CrudService<IUser> {
  constructor() {
    super(model('User', userSchema));
  }

  getPopulatedGroups() {
    // get all users with their group fields populated
    return this.find({}, { populate: ['group'] });
  }

  getByGroupName(name: string) {
    // find users based on the name of their referenced group
    // sort the users on the createdAt date of their group descending
    return this.find({ 'group.name': name }, { sort: ['-group.createdAt'] });
  }

  getFiveUniqueNames(options?: IQueryOptions) {
    // find 5 randomly sorted unique first names while supporting extending the query
    return this.find({}, { ...options, distinct: 'firstName', random: true, limit: 5 });
  }
}
```

### Authorization

Authorization plays a huge part in most production applications and implementing it properly can come at the cost of readability and/or performance. You can implement the `IOnAuthorization` interface to utilize the `onAuthorization()` method in your `CrudService`. This method is triggered on every find query called through the `CrudService` and allows you to return a [MongoDB expression object](https://docs.mongodb.com/manual/meta/aggregation-quick-reference/#aggregation-expressions) to which the returned documents must comply.

_Note: you can imbue the options object with user data to create rules based on context. This is elaborated upon in the [docs](TODO: Deliver url)._

```Typescript
class UsersService extends CrudService<IUser> implements IOnAuthorization {
  constructor() {
    super(model('User', userSchema));
  }

  async onAuthorization(options: IAuthOptions): Promise<Expression> {
    // limit the user's access to just his/her own account
    return { $eq: ['$_id', options.user?._id] };
  }
}
```

### Document middleware

Fundering offers opt-ins for [document middleware](https://mongoosejs.com/docs/middleware.html#types-of-middleware) through service methods. By moving these methods to the service level you are able to keep your logic more centralized and make use of patterns like dependency injection more easily. Fundering also extends the functionality by allowing context injection and keeping all arguments neatly typed.

```Typescript
class UsersService extends CrudService<IUser> implements IPreSave {
  constructor() {
    super(model('User', userSchema));
  }

  async preSave(payload: IUserModel, options?: IQueryOptions<IUser>) {
    // encrypt modified passwords
    if(payload.isModified('password')) {
        payload.password = encrypt(payload.password)
    }
  }
}
```

## Documentation

You can consult the [wiki](https://github.com/MartinDrost/nest-utilities/wiki) for more detailed information about the following subjects:

- [The IQueryOptions object](https://github.com/MartinDrost/fundering/wiki/The-IQueryOptions-object)
- [Querying data](https://github.com/MartinDrost/fundering/wiki/Querying-data)
- [Create, update and delete methods](https://github.com/MartinDrost/fundering/wiki/Create,-update-and-delete-methods)
- [Middleware](https://github.com/MartinDrost/fundering/wiki/Middleware)

## Using Fundering with Nestjs?

Make sure you check out the [nest-utilities](https://github.com/MartinDrost/nest-utilities) package for flexible endpoints and a great developer experience for front-enders and back-enders alike.

---

Made by Martin Drost - [Buy me a ☕](https://paypal.me/martinusdrost)
