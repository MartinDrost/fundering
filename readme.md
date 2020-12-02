<p align='center'>
    A pragmatic service framework for structured and reactive data handling using <a href='https://github.com/Automattic/mongoose' target='_blank'>Mongoose</a>.
</p>

<p align='center'><i>Fun · deer · ing - The Dutch word for foundation</i></p>

<p align='center'>
    <a href='https://www.npmjs.com/~fundering' target='_blank'><img src='https://img.shields.io/npm/v/fundering.svg' alt='NPM Version' /></a>
    <a href='https://www.npmjs.com/~fundering' target='_blank'><img src='https://img.shields.io/npm/dm/fundering.svg' alt='NPM Downloads' /></a>
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

### Authorization

Authorization plays a huge part in most production applications and implementing it properly can come at the cost of readability and/or performance. You can implement the `IOnAuthorization` interface to utilize the `onAuthorization()` method in your `CrudService`. This method is triggered on every find query called through the `CrudService` and allows you to return a [MongoDB expression object](https://docs.mongodb.com/manual/meta/aggregation-quick-reference/#aggregation-expressions) to which the returned documents must comply.

_Note: you can imbue the options object with user data to create rules based on context. This is elaborated upon in the [docs](TODO: Deliver url)._

```Typescript
import { CrudService, IOnAuthorization, Expression } from 'fundering';
import { IAuthOptions } from '../common/auth-options.interface';
import { IUser } from './user.interface';
import { model } from 'mongoose';
import { userSchema } from './user.schema';

export class UsersService extends CrudService<IUser> implements IOnAuthorization {
  constructor() {
    super(model('User', userSchema));
  }

  async onAuthorization(options: IAuthOptions<IUser>): Promise<Expression> {
    // limit the user's access to just his/her own account
    return { $eq: ['$_id', options.user?._id] };
  }
}
```

### Document middleware

```Typescript
import { CrudService, IPreSave } from 'fundering';
import { encrypt } from '../common/encrypt';
import { IAuthOptions } from '../common/auth-options.interface';
import { IUser } from './user.interface';
import { IUserModel } from './user-model.interface';
import { model } from 'mongoose';
import { userSchema } from './user.schema';

export class UsersService extends CrudService<IUser> implements IPreSave {
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

### Querying

```Typescript
import { CrudService } from 'fundering';
import { IUser } from './user.interface';
import { IUserModel } from './user-model.interface';
import { model } from 'mongoose';
import { userSchema } from './user.schema';

export class UsersService extends CrudService<IUser> {
  constructor() {
    super(model('User', userSchema));
  }

  getByGroupName(name: string) {
    // find users based on the name of their populated group
    // sort the users on the createdAt date of their group descending
    return this.find({ 'group.name': name }, { sort: [ '-group.createdAt' ] });
  }
}
```

## Documentation

-- point the viewer to the full documentation with section links to: Querying, Data manipulation(?), Hooks and Authorization

---

Made by Martin Drost - [Buy me a ☕](https://paypal.me/martinusdrost)
