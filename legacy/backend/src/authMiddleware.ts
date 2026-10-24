// @ts-ignore
import express, { Request, Response, NextFunction } from 'express';
// @ts-ignore
import jwt from 'jsonwebtoken';

// @ts-ignore
const secretKey = process.env.SECRET_KEY || 'emergency-secret-key';

export const verifyToken = (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        return res.status(401).send('A token is required for authentication');
    }
    try {
        const decoded = jwt.verify(token, secretKey!);
        req.user = decoded
    } catch (error) {
        return res.status(401).send('Invalid Token');
    }
    return next();
};