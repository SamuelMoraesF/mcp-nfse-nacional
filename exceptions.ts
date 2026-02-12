export class ApplicationException extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ApplicationException';
        Object.setPrototypeOf(this, ApplicationException.prototype);
    }
}

export class UnauthenticatedSessionException extends ApplicationException {
    constructor() {
        super('Sessão não autenticada ou expirada.');
        this.name = 'UnauthenticatedSessionException';
        Object.setPrototypeOf(this, UnauthenticatedSessionException.prototype);
    }
}
