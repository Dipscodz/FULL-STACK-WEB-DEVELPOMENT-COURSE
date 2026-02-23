const express = require('express');
const router = express.Router();

// In-memory post storage
let posts = [
    { id: 1, title: 'First Post', content: 'This is the content of the first post.', date: new Date().toLocaleDateString() },
    { id: 2, title: 'Second Post', content: 'This is the content of the second post.', date: new Date().toLocaleDateString() }
];

// Index - Read all posts
router.get('/', (req, res) => {
    res.render('index', { posts });
});

// New - Show form to create new post
router.get('/new', (req, res) => {
    res.render('new');
});

// Create - Add new post to array
router.post('/posts', (req, res) => {
    const { title, content } = req.body;
    const id = Date.now();
    posts.push({ id, title, content, date: new Date().toLocaleDateString() });
    res.redirect('/');
});

// Edit - Show form to edit post
router.get('/posts/:id/edit', (req, res) => {
    const post = posts.find(p => p.id == req.params.id);
    if (post) {
        res.render('edit', { post });
    } else {
        res.redirect('/');
    }
});

// Update - Update the post
router.post('/posts/:id/edit', (req, res) => {
    const { title, content } = req.body;
    const postIndex = posts.findIndex(p => p.id == req.params.id);
    if (postIndex !== -1) {
        posts[postIndex] = { ...posts[postIndex], title, content };
    }
    res.redirect('/');
});

// Delete - Remove a post
router.post('/posts/:id/delete', (req, res) => {
    posts = posts.filter(p => p.id != req.params.id);
    res.redirect('/');
});

module.exports = router;
